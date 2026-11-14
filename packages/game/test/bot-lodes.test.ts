import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD, playBotMatch } from '../src/bots/play.ts';
import { Ctx } from '../src/bots/context.ts';
import { SurfaceBot } from '../src/bots/surface.ts';
import { CELL, STATS, toTicks, unpackTerrain, type ArmyId, type MatchData, type Observation } from '../src/rules/contract.ts';
import { rotCell } from '../src/util/teams.ts';
import type { Ent } from '../src/sim/ent.ts';
import type { MapDocument } from '../src/maps/document.ts';
import originalSeed21 from './fixtures/peripheral-seed21.json' with { type: 'json' };

type Mode = 'standard' | 'veteran';
function commander(mode: Mode, data: MatchData, army: ArmyId) {
  const bot = createBot(army, 'surface', mode);
  bot.init?.(data);
  return bot;
}

function patrol(slots: 2 | 4, army: ArmyId) {
  const g = createGame({ seed: 21, options: { terrain: 'open', map: { params: { slots, homeLodes: 0 } } } });
  const seat = { team: army, role: 'surface' } as const;
  const data = g.matchData(seat);
  const home = data.armies[0]!.spireAt;
  const original = g.sim.lodes.filter((l) => l.rich).sort((a, b) =>
    Math.hypot(a.c % g.sim.size + 0.5 - home.x, Math.floor(a.c / g.sim.size) + 0.5 - home.y) -
    Math.hypot(b.c % g.sim.size + 0.5 - home.x, Math.floor(b.c / g.sim.size) + 0.5 - home.y))[0]!;
  const cell = rotCell(data.armies.find((a) => a.id === army)!.frame, original.c, g.sim.size);
  const site = { x: cell % g.sim.size, y: Math.floor(cell / g.sim.size) };
  g.sim.tick = toTicks(120);
  for (let i = 0; i < 3; i++) g.sim.add('tank', g.sim.armyIndex(army), 'surface', site.x + 0.5, site.y + 0.5);
  g.sim.armies[g.sim.armyIndex(army)]!.alloy = 0;
  g.sim.computeVision();
  expect(g.apply({ team: army, role: 'sky' }, { kind: 'queue_add', item: 'interceptor' }, { source: 'bot' })).toEqual({ ok: true });
  const obs = g.observe(seat, 0);
  // Isolate the real failed boundary: a local ground patrol, not a centre-control army or point guards.
  obs.entities = obs.entities.filter((e) => e.plane !== 'surface' || e.kind === 'spire' || e.kind === 'post' || e.kind === 'tank' && Math.hypot(e.x - site.x - 0.5, e.y - site.y - 0.5) < 1);
  const c = new Ctx(obs, data, unpackTerrain(data.terrain, g.sim.size));
  expect(c.buildable('headframe', site.x - 1, site.y - 1)).toBe(true);
  expect(c.affordable('headframe', 0)).toBe(false);
  return { g, seat, data, obs, site };
}

const frames = (out: AgentCommandIntent[]) => out.filter((i) => i.kind === 'queue_add' && i.item === 'headframe');

describe('known quiet flank opportunities', () => {
  for (const slots of [2, 4] as const) {
    it.each(['standard', 'veteran'] as const)(`${slots} slots: %s commits a locally held flank without a centre-control army or spare funds`, (mode) => {
      for (const army of slots === 2 ? ['nw', 'se'] as const : ['nw', 'ne', 'se', 'sw'] as const) {
        const { g, seat, data, obs, site } = patrol(slots, army);
        const out = frames(commander(mode, data, army).think(obs));
        expect(out, army).toEqual([{ kind: 'queue_add', item: 'headframe', ...site, index: 0 }]);
        expect(g.apply(seat, out[0]!, { source: 'bot' })).toEqual({ ok: true });
        obs.queue = g.observe(seat, 0).queue;
        expect(obs.queue[0]).toMatchObject({ item: 'headframe', status: 'waiting', reason: 'funds' });
        expect(frames(commander(mode, data, army).think(obs))).toEqual([]);
      }
    });
  }
  it.each(['standard', 'veteran'] as const)('%s does not turn the patrol exception into blind or unsafe expansion', (mode) => {
    for (const army of ['nw', 'se'] as const) {
      const { data, obs, site } = patrol(2, army);
      const think = (o: Observation) => commander(mode, data, army).think(o);
      expect(frames(think({ ...obs, lodes: [] }))).toEqual([]);
      expect(frames(think({ ...obs, holes: [{ ...site, kind: 'crater' }] }))).toEqual([]);
      expect(frames(think({ ...obs, mandate: { ...obs.mandate, directive: { stance: 'defend' } } }))).toEqual([]);
      const tanks = obs.entities.filter((e) => e.kind === 'tank');
      expect(frames(think({ ...obs, entities: obs.entities.filter((e) => e !== tanks[0]) }))).toEqual([]);
      const hostile = { ...tanks[0]!, id: 'e_hostile', side: army === 'nw' ? 'se' as const : 'nw' as const };
      expect(frames(think({ ...obs, entities: [...obs.entities, hostile] }))).toEqual([]);
      const home = data.armies.find((a) => a.id === army)!.spireAt;
      expect(frames(think({ ...obs, entities: [...obs.entities, { ...hostile, ...home }] }))).toEqual([]);
      const approach = think({ ...obs, entities: obs.entities.map((e) => tanks.includes(e) ? { ...e, ...home } : e) });
      expect(frames(approach)).toEqual([]);
      expect(approach).toContainEqual(expect.objectContaining({ kind: 'move', mode: 'fight', x: site.x + 0.5, y: site.y + 0.5 }));
    }
  });
  it.each(['standard', 'veteran'] as const)('%s keeps a home-outcrop scout ahead of optional post detachments', (mode) => {
    for (const army of ['nw', 'se'] as const) {
      const g = createGame({ seed: 21, options: { map: { document: originalSeed21 as MapDocument } } });
      g.sim.tick = toTicks(120);
      const seat = { team: army, role: 'surface' } as const;
      const data = g.matchData(seat), obs = g.observe(seat, 0);
      const homeLodes = obs.lodes.filter((l) => !l.rich);
      obs.res.alloy = obs.res.freeAlloy = 0;
      obs.entities = obs.entities.map((e) => e.side === army && e.plane === 'surface' && ['trooper', 'tank', 'flak'].includes(e.kind)
        ? { ...e, x: army === 'nw' ? 18.5 : 29.5, y: army === 'nw' ? 18.5 : 29.5 } : e);
      const c = new Ctx(obs, data, unpackTerrain(data.terrain, g.sim.size));
      expect(homeLodes.some((l) => c.buildable('headframe', l.x - 1, l.y - 1, false))).toBe(true);
      expect(homeLodes.some((l) => c.buildable('headframe', l.x - 1, l.y - 1, true))).toBe(false);
      const out = commander(mode, data, army).think(obs);
      expect(out.some((i) => i.kind === 'move' && i.mode === 'move' && i.units.length === 1 &&
        homeLodes.some((l) => i.x === l.x + 0.5 && i.y === l.y + 0.5))).toBe(true);
    }
  });
});

/** Three free ground fighters at home; the stepped C2 case starts with no rich outcrop known. */
function searchPatrol(slots: 2 | 4, army: ArmyId, tanks: 2 | 3) {
  const g = createGame({ seed: 21, options: { terrain: 'open', map: { params: { slots, homeLodes: 0 } } } });
  const seat = { team: army, role: 'surface' } as const;
  const side = g.sim.armyIndex(army);
  const tank = g.sim.ents.find((e) => e.side === side && e.kind === 'tank')!;
  for (let i = 1; i < tanks; i++) g.sim.add('tank', side, 'surface', tank.x, tank.y);
  g.sim.tick = toTicks(120);
  g.sim.computeVision();
  const data = g.matchData(seat), obs = g.observe(seat, 0);
  obs.entities = obs.entities.filter((e) => e.plane !== 'surface' || e.kind === 'spire' || e.kind === 'post' || e.kind === 'tank');
  return { g, seat, data, obs };
}

/** Observe the selected public search cell without changing either commander's decisions. */
function searchDecision(mode: Mode, data: MatchData, army: ArmyId, obs: Observation) {
  type Point = { x: number; y: number } | undefined;
  const bot = commander(mode, data, army);
  const traced = bot as unknown as { expandLodes(c: Ctx, out: AgentCommandIntent[], army: Observation['entities'], scope: 'home' | 'patrol' | 'rich'): Point };
  const original = traced.expandLodes;
  let point: Point;
  traced.expandLodes = function(c, out, units, scope) {
    const selected = original.call(this, c, out, units, scope);
    if (scope !== 'home') point = selected;
    return selected;
  };
  return { out: bot.think(obs), point };
}

/** Persistent post assignments and a three-fighter patrol, with an actual usable own Shaft. */
function committedPatrol(mode: Mode, army: ArmyId) {
  const { g, seat, data } = searchPatrol(2, army, 2);
  const side = g.sim.armyIndex(army), at = army === 'nw' ? 14.5 : g.sim.size - 14.5;
  const shaft = g.sim.build(side, 'shaft', at, at, 'surface');
  for (let i = 0; i <= STATS.shaft.build; i++) g.step();
  const beside = Math.floor(at) * g.sim.size + Math.floor(at) + (army === 'nw' ? 1 : -1);
  g.sim.cells[beside] = CELL.tunnel;
  g.sim.armies[side]!.group.known[beside] = CELL.tunnel;
  g.sim.computeVision();
  expect(g.sim.shaftSealed(side, shaft)).toBe(false);
  const obs = g.observe(seat, 0);
  const troops = obs.entities.filter((e) => e.side === army && e.kind === 'trooper');
  const guards = troops.slice(0, 3), fresh = troops[3]!, forward = troops[4]!;
  const base = obs.entities.filter((e) => e.kind !== 'trooper');
  const bot = commander(mode, data, army);
  const first = bot.think({ ...obs, entities: [...base, ...guards],
    mandate: { ...obs.mandate, directive: { stance: 'defend' } } });
  const jobs = new Map(guards.map((e) => {
    const order = first.find((i) => i.kind === 'attack' && i.units.includes(e.id));
    expect(order?.kind).toBe('attack');
    if (order?.kind !== 'attack') throw new Error('Expected initial post assignment');
    return [e.id, obs.entities.find((p) => p.id === order.target)!] as const;
  }));
  const other = data.posts.find((p) => p.kind === 'contested' && ![...jobs.values()].some((p2) => p2.id === p.id))!;
  const view = () => ({ ...g.observe(seat, 0), entities: [...base,
    ...guards.map((e) => ({ ...e, tx: jobs.get(e.id)!.x, ty: jobs.get(e.id)!.y })),
    fresh, { ...forward, tx: other.x, ty: other.y }] });
  const advance = () => { for (let i = 0; i < toTicks(3); i++) g.step(); };
  advance();
  expect(bot.think(view())).toContainEqual(expect.objectContaining({
    kind: 'move', mode: 'fight', units: expect.arrayContaining([fresh.id]),
  }));
  return { g, seat, side, at, troops, bot, view, advance };
}

describe('public friendly-flank discovery', () => {
  for (const slots of [2, 4] as const) {
    it.each(['standard', 'veteran'] as const)(`${slots} slots: %s searches only quiet legal own-side flank points with three free fighters`, (mode) => {
      let canonical: number | undefined;
      for (const army of slots === 2 ? ['nw', 'se'] as const : ['nw', 'ne', 'se', 'sw'] as const) {
        const { g, data, obs } = searchPatrol(slots, army, 3);
        // Isolate discovery rather than known-site selection (C4 can reveal a nearby outcrop at spawn).
        obs.lodes = [];
        const choose = (o = obs, d = data) => searchDecision(mode, d, army, o);
        const result = choose();
        expect(result.point, army).toBeDefined();
        expect(frames(result.out)).toEqual([]);
        const p = result.point!;
        const at = { x: p.x + 0.5, y: p.y + 0.5 };
        const c = new Ctx(obs, data, unpackTerrain(data.terrain, g.sim.size));
        expect(c.walkable(p.y * g.sim.size + p.x)).toBe(true);
        expect(Math.hypot(at.x - c.home.x, at.y - c.home.y)).toBeLessThan(c.hostileSpireDist(at));
        const key = c.frame.cellKey(p.y * g.sim.size + p.x);
        canonical ??= key;
        expect(key, army).toBe(canonical);
        expect(result.out).toContainEqual(expect.objectContaining({ kind: 'move', mode: 'fight', ...at }));

        const tanks = obs.entities.filter((e) => e.side === army && e.kind === 'tank');
        expect(choose({ ...obs, entities: obs.entities.filter((e) => e !== tanks[0]) }).point).toBeUndefined();
        expect(choose({ ...obs, entities: obs.entities.map((e) => e === tanks[0] ? { ...e, kind: 'flak' } : e) }).point).toBeUndefined();
        expect(choose({ ...obs, mandate: { ...obs.mandate, directive: { stance: 'defend' } } }).point).toBeUndefined();
        const hostile = { ...tanks[0]!, id: 'e_hostile', side: data.armies.find((a) => a.id !== army)!.id };
        expect(choose({ ...obs, entities: [...obs.entities, { ...hostile, ...c.home }] }).point).toBeUndefined();
        const threatened = choose({ ...obs, entities: [...obs.entities, { ...hostile, ...at }] }).point;
        if (threatened) expect(Math.hypot(threatened.x + 0.5 - at.x, threatened.y + 0.5 - at.y)).toBeGreaterThanOrEqual(8);
        const blocked = choose({ ...obs, holes: [...obs.holes, { ...p, kind: 'crater' }] }).point;
        expect(blocked).not.toEqual(p);

        // Even a centre-zone rim on our side is not a flank patrol; no eligible points means no invented fallback.
        const centreOnly = structuredClone(data);
        centreOnly.rules.map.contestedZones = centreOnly.rules.map.contestedZones.map((z) => ({ ...z, kind: 'centre' }));
        expect(choose(obs, centreOnly).point).toBeUndefined();
        const enemySector = structuredClone(data);
        enemySector.rules.map.contestedZones = enemySector.rules.map.contestedZones.map((z) => ({ ...z, minRadius: 0, maxRadius: 0 }));
        expect(choose(obs, enemySector).point).toBeUndefined();
        // The original centre-control gate still permits centre searches with the full tier force.
        const threshold = mode === 'veteran' ? 14 : 10;
        const full = { ...obs, entities: [...obs.entities, ...Array.from({ length: threshold - 3 }, (_, i) => ({ ...tanks[0]!, id: `e_extra${i}` }))] };
        expect(choose(full, centreOnly).point).toBeDefined();
      }
    });
  }

  it.each(['standard', 'veteran'] as const)('%s discovers a real outcrop by stepping its public-recipe patrol', (mode) => {
    for (const army of ['nw', 'se'] as const) {
      const { g, seat, data, obs } = searchPatrol(2, army, 3);
      expect(obs.lodes.filter((l) => l.rich)).toEqual([]);
      const bot = commander(mode, data, army);
      expect(searchDecision(mode, data, army, obs).point).toBeDefined();
      const until = g.tick + toTicks(120);
      let discovered = false;
      while (g.tick < until && !discovered) {
        if (g.tick % BOT_PERIOD === 0) {
          const view = g.observe(seat, 0);
          discovered = view.lodes.some((l) => l.rich);
          if (discovered) break;
          for (const i of bot.think(view)) {
            expect(i.kind === 'queue_add' && i.item === 'headframe').toBe(false);
            g.apply(seat, i, { source: 'bot' });
          }
        }
        g.step();
      }
      expect(discovered, army).toBe(true);
    }
  }, 30_000);
});

describe('friendly-flank troop allocation', () => {
  for (const slots of [2, 4] as const) {
    it.each(['standard', 'veteran'] as const)(`${slots} slots: %s reserves the fresh third fighter without taking existing post jobs or home acquisition`, (mode) => {
      for (const army of slots === 2 ? ['nw', 'se'] as const : ['nw', 'ne', 'se', 'sw'] as const) {
        const { g, seat, data, obs } = searchPatrol(slots, army, 2);
        obs.lodes = [];
        // Veteran C4 already staffs two points. Prime both jobs, without adding any available patrol fighters.
        const guardCount = mode === 'veteran' && slots === 4 ? 6 : 3;
        const guardAt = g.sim.ents.find((e) => e.side === g.sim.armyIndex(army) && e.kind === 'trooper')!;
        for (let i = 3; i < guardCount; i++) g.sim.add('trooper', g.sim.armyIndex(army), 'surface', guardAt.x, guardAt.y);
        const troopers = g.observe(seat, 0).entities.filter((e) => e.side === army && e.kind === 'trooper');
        const guards = troopers.slice(0, guardCount), fresh = troopers[guardCount]!, forward = troopers[guardCount + 1]!;
        const freeView = { ...obs, entities: [...obs.entities, fresh] };
        const point = searchDecision(mode, data, army, freeView).point!;
        expect(point).toBeDefined();
        const at = { x: point.x + 0.5, y: point.y + 0.5 };
        const run = (lostHome: boolean) => {
          const bot = commander(mode, data, army);
          const first = bot.think({ ...obs, entities: [...obs.entities, ...guards],
            mandate: { ...obs.mandate, directive: { stance: 'defend' } } });
          const destinations = new Map(guards.map((e) => {
            const assigned = first.find((i) => i.kind === 'attack' && i.units.includes(e.id));
            expect(assigned?.kind).toBe('attack');
            if (!assigned || assigned.kind !== 'attack') throw new Error('Expected initial post assignment');
            return [e.id, obs.entities.find((p) => p.id === assigned.target)!] as const;
          }));
          const other = data.posts.find((p) => p.kind === 'contested' && ![...destinations.values()].some((goal) => goal.id === p.id))!;
          const home = data.posts.find((p) => p.home === army)!;
          const view = { ...obs, tick: obs.tick + toTicks(3), entities: [
            ...obs.entities.map((e) => lostHome && e.id === home.id ? { ...e, side: 'neutral' as const } : e),
            ...guards.map((e) => ({ ...e, tx: destinations.get(e.id)!.x, ty: destinations.get(e.id)!.y })), fresh,
            { ...forward, tx: other.x, ty: other.y },
          ] };
          return { out: bot.think(view), home };
        };
        const { out } = run(false);
        expect(out).toContainEqual(expect.objectContaining({ kind: 'move', mode: 'fight', ...at, units: expect.arrayContaining([fresh.id]) }));
        expect(out.some((i) => 'units' in i && i.units.some((id) => guards.some((e) => e.id === id) || id === forward.id))).toBe(false);
        expect(out.some((i) => i.kind === 'attack' && i.units.includes(fresh.id))).toBe(false);
        const retake = run(true);
        expect(retake.out).toContainEqual(expect.objectContaining({ kind: 'attack', target: retake.home.id, units: expect.arrayContaining([fresh.id]) }));
        expect(retake.out.some((i) => i.kind === 'move' && i.x === at.x && i.y === at.y && i.units.includes(fresh.id))).toBe(false);
      }
    });
  }

  it.each(['standard', 'veteran'] as const)('%s keeps local commitments through ordinary staffing but still answers explicit defence', (mode) => {
    for (const army of ['nw', 'se'] as const) {
      const { g, seat, side, at, troops, bot, view, advance } = committedPatrol(mode, army);
      const ask = (need: 'troops' | 'defend') => {
        expect(g.apply({ team: army, role: 'depths' }, { kind: 'signal',
          signal: { kind: 'request_support', to: 'surface', need, count: 2,
            x: Math.floor(at), y: Math.floor(at), ...(need === 'defend' ? { plane: 'depths' as const } : {}) },
        })).toEqual({ ok: true });
      };
      advance();
      ask('troops');
      const ordinary = bot.think(view());
      expect(ordinary.filter((i) => i.kind === 'transfer')).toEqual([]);
      expect(ordinary).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'ack' });
      for (const intent of ordinary) if (intent.kind === 'signal_update') expect(g.apply(seat, intent)).toEqual({ ok: true });
      advance();
      ask('defend');
      const urgent = bot.think(view());
      // The waiting ordinary request must not borrow the urgent request's override.
      const transfers = urgent.filter((i) => i.kind === 'transfer');
      expect(transfers).toHaveLength(1);
      expect(transfers[0]).toMatchObject({ to: 'depths', units: expect.arrayContaining([expect.any(String)]) });
      expect(transfers[0]!.units).toHaveLength(2);
      expect(transfers[0]!.units.every((id) => troops.some((e) => e.id === id))).toBe(true);
      expect(urgent).toContainEqual({ kind: 'signal_update', id: 'sg_2', update: 'ack' });
      for (const intent of urgent) if (intent.kind === 'signal_update' || intent.kind === 'transfer') expect(g.apply(seat, intent)).toEqual({ ok: true });
      advance();
      const extra = g.sim.spawnUnit(side, 'trooper', 'surface');
      const surplus = g.observe(seat, 0).entities.find((e) => e.id === g.entityId(army, extra.id))!;
      const spareView = view();
      spareView.entities.push(surplus);
      const staffed = bot.think(spareView).filter((i) => i.kind === 'transfer');
      // The waiting ordinary task may use one spare: protected local troops already satisfy the existing reserve.
      expect(staffed).toHaveLength(1);
      expect(staffed[0]!.units).toEqual([surplus.id]);
    }
  });

  it.each(['standard', 'veteran'] as const)('%s keeps local jobs through optional raids but permits emergency transfers', (mode) => {
    for (const army of ['nw', 'se'] as const) {
      const { bot, view, advance } = committedPatrol(mode, army);
      advance();
      const tempting = view();
      const miner = tempting.entities.find((e) => e.kind === 'digger' && e.side === army)!;
      const enemy = army === 'nw' ? 'se' as const : 'nw' as const;
      // A visible unguarded enemy economy is a real greedy-raid trigger, not an emergency.
      tempting.entities.push(...Array.from({ length: 6 }, (_, i) => ({
        ...miner, id: `enemy_miner_${i}`, side: enemy, x: 24.5, y: 24.5,
      })));
      expect(bot.think(tempting).some((i) => i.kind === 'transfer')).toBe(false);
      // Scheduled breach raids use the same uncommitted pool.
      const scheduled = { ...tempting, tick: toTicks(420) };
      expect(bot.think(scheduled).some((i) => i.kind === 'transfer')).toBe(false);
      const urgent = { ...scheduled, tick: scheduled.tick + toTicks(3) };
      urgent.entities = [...scheduled.entities, { ...miner, id: 'enemy_guard', side: enemy, kind: 'trooper' }];
      expect(bot.think(urgent).some((i) => i.kind === 'transfer')).toBe(true);
    }
  });

  it('the original standard opening assembles and moves its first fresh-fighter flank patrol', () => {
    type State = { pointSquads: Map<string, string>; lodePatrol: Set<string> };
    const prototype = SurfaceBot.prototype as unknown as { decide(this: State, c: Ctx): AgentCommandIntent[] };
    const original = prototype.decide;
    let mission: { tick: number; id: string; x: number; y: number; goal: { x: number; y: number }; reserved: string[] } | undefined;
    let travelled = 0, discovered = 0;
    prototype.decide = function(c) {
      const assigned = new Set(this.pointSquads.keys());
      const out = original.call(this, c);
      if (c.army === 'nw' && !mission && this.lodePatrol.size === 3) {
        const recruit = c.own.find((e) => e.kind === 'trooper' && this.lodePatrol.has(e.id) && !assigned.has(e.id));
        const move = recruit && out.find((i) => i.kind === 'move' && i.mode === 'fight' && i.units.includes(recruit.id));
        if (recruit && move?.kind === 'move') {
          for (const id of this.lodePatrol) expect(assigned.has(id)).toBe(false);
          expect(c.match.posts.filter((p) => p.home === c.army).every((p) => c.posts.some((e) => e.id === p.id && e.side === c.army))).toBe(true);
          expect(Math.hypot(move.x - c.home.x, move.y - c.home.y)).toBeLessThan(c.hostileSpireDist(move));
          mission = { tick: c.obs.tick, id: recruit.id, x: recruit.x, y: recruit.y, goal: { x: move.x, y: move.y }, reserved: [...this.lodePatrol] };
        }
      }
      return out;
    };
    try {
      // The Surface seats play the in-process bot this test instruments: a built package (bots:build, as CI runs it
      // first) is the same bot compiled into the skill's library, which the prototype hook never sees.
      playBotMatch({
        seed: 21, options: { map: { document: originalSeed21 as MapDocument } },
        levels: { nw: 'standard', se: 'standard' }, maxTicks: toTicks(200),
        seats: { nw: { surface: createBot('nw', 'surface', 'standard') }, se: { surface: createBot('se', 'surface', 'standard') } },
        onTick(g) {
          if (!mission) return;
          const e = g.sim.ents.find((e) => !e.dead && e.side === g.sim.armyIndex('nw') && g.entityId('nw', e.id) === mission!.id);
          if (e) travelled = Math.max(travelled, Math.hypot(e.x - mission.x, e.y - mission.y));
          if (!discovered && g.tick % BOT_PERIOD === 0 && g.observe({ team: 'nw', role: 'surface' }, 0).lodes.some((l) => l.rich)) discovered = g.tick;
        },
      });
    } finally {
      prototype.decide = original;
    }
    console.log(JSON.stringify({ allocation: mission, travelled, discovered }));
    expect(mission).toBeDefined();
    expect(travelled).toBeGreaterThan(5);
    expect(discovered).toBeGreaterThan(mission!.tick);
  }, 30_000);
});

interface LodeEvidence {
  rows: { discovered: number; queuedAt: number; constructed: number; extractedAt: number; deliveredAt: number; extracted: number; delivered: number; carried: number; lost: number }[];
  collect(): void;
}

/** Observe real extraction/delivery boundaries, without changing orders, resources or the simulation result. */
function ledger(g: AgentCommandGame): LodeEvidence {
  const rows = g.sim.armyIds.map(() => ({ discovered: 0, queuedAt: 0, constructed: 0, extractedAt: 0, deliveredAt: 0, extracted: 0, delivered: 0, carried: 0, lost: 0 }));
  const cargo = new Map<Ent, number>();
  const mine = g.sim.updateMine;
  g.sim.updateMine = function(e, order) {
    const before = e.lodeCarry;
    const alloy = this.armies[e.side]!.alloy;
    const total = e.carry;
    let reserves = 0;
    for (const l of this.lodes) if (l.rich) reserves += l.left;
    mine.call(this, e, order);
    const amount = e.lodeCarry - before;
    const row = rows[e.side]!;
    if (amount > 0 && this.lodes[this.lodeAt[order.ore]!]!.rich) {
      for (const l of this.lodes) if (l.rich) reserves -= l.left;
      expect(reserves * this.econ.oreLoad).toBe(amount);
      row.extractedAt ||= this.tick;
      row.extracted += amount;
      cargo.set(e, (cargo.get(e) ?? 0) + amount);
    } else if (before > 0 && e.lodeCarry === 0 && cargo.has(e)) {
      const rich = cargo.get(e)!;
      expect(this.armies[e.side]!.alloy - alloy).toBeCloseTo(total, 8);
      expect(rich).toBeLessThanOrEqual(before);
      row.deliveredAt ||= this.tick;
      row.delivered += rich;
      cargo.delete(e);
    }
  };
  return {
    rows,
    collect() {
      for (const row of rows) row.carried = 0;
      for (const [e, amount] of cargo) {
        if (e.dead) {
          rows[e.side]!.lost += amount;
          cargo.delete(e);
        } else {
          expect(amount).toBeLessThanOrEqual(e.lodeCarry);
          rows[e.side]!.carried += amount;
        }
      }
      for (const [a, army] of g.sim.armyIds.entries()) {
        const row = rows[a]!;
        if (!row.discovered && g.tick % BOT_PERIOD === 0 && g.observe({ team: army, role: 'surface' }, 0).lodes.some((l) => l.rich)) row.discovered = g.tick;
        if (!row.constructed && g.sim.ents.some((e) => !e.dead && e.side === a && e.kind === 'headframe' && e.built && g.sim.lodes[g.sim.lodeAt[Math.floor(e.y) * g.sim.size + Math.floor(e.x)]!]?.rich)) row.constructed = g.tick;
        expect(row.extracted).toBe(row.delivered + row.carried + row.lost);
      }
    },
  };
}

describe('peripheral ore end to end', { tags: ['timing'] }, () => {
  it.each(['standard', 'veteran'] as const)('%s discovers, builds, extracts and delivers in natural mirrored seed21 play', (level) => {
    let evidence: LodeEvidence | undefined;
    const result = playBotMatch({
      seed: 21, levels: { nw: level, se: level }, maxTicks: toTicks(15 * 60),
      // Freeze the originally failing generated layout for standard; veteran exercises current generation.
      options: level === 'standard' ? { map: { document: originalSeed21 as MapDocument } } : {},
      onTick(g) { evidence ??= ledger(g); evidence.collect(); },
      onIntent(g, seat, intent, result) {
        if (!evidence || !result.ok || intent.kind !== 'queue_add' || intent.item !== 'headframe' || intent.x === undefined || intent.y === undefined) return;
        const l = g.sim.lodes[g.sim.lodeAt[Math.floor(intent.y) * g.sim.size + Math.floor(intent.x)]!];
        if (l?.rich) evidence.rows[g.sim.armyIds.indexOf(seat.team)]!.queuedAt ||= g.tick;
      },
    });
    console.log(JSON.stringify({ level, seed: 21, ticks: result.ticks, conditions: `default rules/starts, equal-tier bots; ${level === 'standard' ? 'original captured' : 'current generated'} map`, armies: evidence!.rows }));
    if (evidence!.rows.some((row) => !row.delivered)) {
      console.log(JSON.stringify({ remainingPatrol: result.game.sim.ents.filter((e) => !e.dead && e.plane === 'surface' && e.unit).map((e) => ({
        id: e.id, side: e.side, kind: e.kind, x: e.x, y: e.y, state: e.state, order: e.order, waypoint: [e.wx, e.wy],
      })) }));
    }
    for (const row of evidence!.rows) {
      expect(row.discovered).toBeGreaterThan(0);
      expect(row.queuedAt).toBeGreaterThan(row.discovered);
      expect(row.constructed).toBeGreaterThan(row.queuedAt);
      expect(row.extractedAt).toBeGreaterThan(row.constructed);
      expect(row.deliveredAt).toBeGreaterThan(row.extractedAt);
      expect(row.delivered).toBeGreaterThan(0);
    }
    expect(evidence!.rows[1]).toEqual(evidence!.rows[0]);
  }, 120_000);

  it('a real stepped patrol opening hands its pocket to the Depths and delivers ore', () => {
    const { g, seat, data, obs } = patrol(2, 'nw');
    const surface = commander('standard', data, 'nw');
    const depths = createBot('nw', 'depths', 'standard');
    const below = { team: 'nw', role: 'depths' } as const;
    depths.init?.(g.matchData(below));
    const evidence = ledger(g);
    evidence.collect();
    for (const i of surface.think(obs)) {
      const applied = g.apply(seat, i, { source: 'bot' });
      if (i.kind === 'queue_add' && i.item === 'headframe') {
        expect(applied.ok, JSON.stringify(i)).toBe(true);
        evidence.rows[0]!.queuedAt = g.tick;
      } else if (!applied.ok) {
        expect(i.kind === 'queue_add' && i.ifAffordable === true && applied.code === 'cannot_afford', JSON.stringify(i)).toBe(true);
      }
    }
    const until = g.tick + toTicks(10 * 60);
    while (g.tick < until && !evidence.rows[0]!.delivered) {
      if (g.tick % BOT_PERIOD === 0) {
        const a = surface.think(g.observe(seat, 0)), b = depths.think(g.observe(below, 0));
        g.sim.round(() => {
          for (const i of a) g.apply(seat, i, { source: 'bot' });
          for (const i of b) g.apply(below, i, { source: 'bot' });
        });
      }
      g.step();
      evidence.collect();
    }
    expect(evidence.rows[0]!.delivered).toBeGreaterThan(0);
    console.log(`stepped patrol ${JSON.stringify(evidence.rows[0])}`);
  }, 120_000);
});
