/**
 * Built-in bots and team signals (bots/signals.ts), mirrored for both duel armies: they answer teammates' requests
 * (troopers down an own Shaft, a scan, air cover), ask in their trigger situations, do nothing signal-related when the
 * `signals.enabled` rule is off, and two equal bot armies exchange exactly mirrored signal traffic.
 */
import { describe, expect, it } from 'vitest';
import { CELL, STATS, footprintDistance, toTicks, type Observation, type Plane } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD, playBotMatch } from '../src/bots/play.ts';
import { TIERS, WARDEN_AT, WARDEN_POST_MAX } from '../src/bots/tuning.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const DUEL = ['nw', 'se'] as const;
type Team = (typeof DUEL)[number];
type Entry = Observation['signals']['inbox'][number];

const armyOf = (team: Team): number => slotOfArmyId(team, 2);
const enemyOf = (team: Team): Team => (team === 'nw' ? 'se' : 'nw');
/** The C2 mirror of a nw-side point coordinate, and of a nw-side tile. */
const at = (team: Team, v: number, size: number): number => (team === 'nw' ? v : size - v);
const tileAt = (team: Team, v: number, size: number): number => (team === 'nw' ? v : size - 1 - v);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

function bot(g: AgentCommandGame, team: Team, role: Plane, level: 'standard' | 'novice' = 'standard') {
  const b = createBot(team, role, level);
  b.init?.(g.matchData({ team, role }));
  return b;
}

/** Drive one seat's bot for `ticks` (observe, think, apply every BOT_PERIOD); every intent it sent, in order. */
function drive(g: AgentCommandGame, team: Team, role: Plane, ticks: number, until?: () => boolean): AgentCommandIntent[] {
  const b = bot(g, team, role);
  const seat = { team, role };
  const sent: AgentCommandIntent[] = [];
  let since = g.tick;
  for (const end = g.tick + ticks; g.tick < end && !until?.();) {
    if (g.tick % BOT_PERIOD === 0) {
      const intents = b.think(g.observe(seat, since));
      since = g.tick;
      for (const intent of intents) {
        g.apply(seat, intent, { source: 'bot' });
        sent.push(intent);
      }
    }
    g.step();
  }
  return sent;
}

const board = (g: AgentCommandGame, team: Team): Entry[] => g.signals.team(team) as Entry[];
const request = (g: AgentCommandGame, team: Team, from: Plane, signal: Record<string, unknown>) =>
  g.apply({ team, role: from }, { kind: 'signal', signal: { kind: 'request_support', ...signal } } as AgentCommandIntent);

/** Seed 3: a built, unsealed Shaft of `team` at the mirror of (14.5, 14.5) (its landing joined to a tunnel). */
function withShaft(team: Team, options = {}) {
  const g = createGame({ seed: 3, options });
  const s = g.sim;
  const shaft = s.build(armyOf(team), 'shaft', at(team, 14.5, s.size), at(team, 14.5, s.size), 'surface');
  steps(g, STATS.shaft.build + 1 + VISION_EVERY);
  const landing = cellOfEnt(shaft, s.size);
  const beside = landing + (team === 'nw' ? 1 : -1);
  s.cells[beside] = CELL.tunnel;
  s.armies[armyOf(team)]!.group.known[beside] = CELL.tunnel;
  expect(s.shaftSealed(armyOf(team), shaft)).toBe(false);
  return { g, shaft };
}

describe('bots answer team signals', () => {
  it.each(DUEL)('%s: Surface sends the troopers the Depths asked for down an own Shaft, then reports done', (team) => {
    const { g, shaft } = withShaft(team);
    const s = g.sim;
    const troopers = Array.from({ length: 6 }, () => g.entityId(team, s.add('trooper', armyOf(team), 'surface', at(team, 18, s.size), at(team, 18, s.size)).id));
    const tile = tileAt(team, 14, s.size);
    expect(request(g, team, 'depths', { to: 'surface', need: 'troops', count: 3, x: tile, y: tile })).toEqual({ ok: true });
    const sent = drive(g, team, 'surface', toTicks(40), () => board(g, team)[0]?.state === 'completed');
    expect(sent).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'ack' });
    const down = sent.find((i) => i.kind === 'transfer');
    expect(down).toMatchObject({ kind: 'transfer', to: 'depths' });
    if (down?.kind !== 'transfer') return;
    // Through that Shaft: the transfer point lies on its footprint.
    expect(footprintDistance('shaft', shaft.x, shaft.y, down.x!, down.y!)).toBeLessThanOrEqual(0);
    expect(down.units).toHaveLength(3);
    expect(down.units.every((id) => troopers.includes(id))).toBe(true);
    expect(board(g, team)[0]).toMatchObject({ state: 'completed', by: 'surface' });
    expect(down.units.every((id) => s.ents.find((e) => e.id === s.aliasTarget(armyOf(team), Number(id.slice(2))))?.plane === 'depths')).toBe(true);
  });

  it.each(DUEL)('%s: Surface without an own Shaft acks a troops request from the Depths and puts a Shaft up for it', (team) => {
    const g = createGame({ seed: 3 });
    for (let i = 0; i < 6; i++) g.sim.spawnUnit(armyOf(team), 'trooper', 'surface');
    expect(request(g, team, 'depths', { to: 'surface', need: 'troops', count: 3 })).toEqual({ ok: true });
    const sent = drive(g, team, 'surface', TIERS.standard.period + BOT_PERIOD);
    expect(sent).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'ack' });
    expect(sent.some((i) => i.kind === 'queue_add' && i.item === 'shaft')).toBe(true);
    expect(sent.some((i) => i.kind === 'transfer')).toBe(false);
    expect(board(g, team)[0]).toMatchObject({ state: 'working', by: 'surface' });
    // A novice Surface declines instead.
    const novice = createGame({ seed: 3 });
    expect(request(novice, team, 'depths', { to: 'surface', need: 'troops', count: 3 })).toEqual({ ok: true });
    expect(bot(novice, team, 'surface', 'novice').think(novice.observe({ team, role: 'surface' }, 0))).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'decline' });
  });

  it.each(DUEL)('%s: Orbit acks a scan request, scans the tile once its scan is ready and reports done', (team) => {
    const g = createGame({ seed: 3 });
    const tile = tileAt(team, 20, g.sim.size);
    expect(request(g, team, 'surface', { to: 'orbit', need: 'scan', x: tile, y: tile })).toEqual({ ok: true });
    const orbit = bot(g, team, 'orbit');
    const seat = { team, role: 'orbit' as const };
    const think = (ready: boolean): AgentCommandIntent[] => {
      const obs = g.observe(seat, 0);
      obs.res.energy = obs.res.freeEnergy = 1000;
      obs.res.scanReadyAt = ready ? 0 : obs.tick + toTicks(60);
      const out = orbit.think(obs);
      for (const intent of out) if (intent.kind === 'signal_update') g.apply(seat, intent, { source: 'bot' });
      return out;
    };
    const waiting = think(false);
    expect(waiting).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'ack' });
    expect(waiting.some((i) => i.kind === 'scan' || (i.kind === 'signal_update' && i.update !== 'ack'))).toBe(false);
    expect(board(g, team)[0]).toMatchObject({ state: 'working', by: 'orbit' });
    steps(g, TIERS.standard.period);
    const ready = think(true);
    expect(ready).toContainEqual({ kind: 'scan', x: tile + 0.5, y: tile + 0.5 });
    expect(ready).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'done' });
    expect(board(g, team)[0]?.state).toBe('completed');
  });

  it.each(DUEL)('%s: Sky screens a tile with interceptors, and ascends them there for Orbit once researched', (team) => {
    const g = createGame({ seed: 3 });
    const s = g.sim;
    const tile = tileAt(team, 20, s.size);
    const centre = tile + 0.5;
    const near = [0, 1].map(() => g.entityId(team, s.add('interceptor', armyOf(team), 'sky', centre, centre).id));
    for (let i = 0; i < 4; i++) s.spawnUnit(armyOf(team), 'interceptor', 'sky');
    const sky = bot(g, team, 'sky');
    const seat = { team, role: 'sky' as const };
    const think = (): AgentCommandIntent[] => {
      const obs = g.observe(seat, 0);
      obs.res.energy = obs.res.freeEnergy = 1000;
      obs.research = { ...obs.research, completed: [...obs.research.completed, 'ascent_thrusters'] };
      const out = sky.think(obs);
      for (const intent of out) if (intent.kind === 'signal_update') g.apply(seat, intent, { source: 'bot' });
      return out;
    };
    expect(request(g, team, 'surface', { to: 'sky', need: 'air_cover', count: 2, x: tile, y: tile })).toEqual({ ok: true });
    const screen = think();
    expect(screen).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'ack' });
    expect(screen).toContainEqual({ kind: 'move', units: near, x: centre, y: centre, mode: 'fight' });
    steps(g, TIERS.standard.period);
    expect(request(g, team, 'orbit', { to: 'sky', need: 'air_cover', count: 2, x: tile, y: tile })).toEqual({ ok: true });
    // The screening pair holds sg_1; the next nearest ready pair answers Orbit and ascends once at the tile.
    const cover = think();
    expect(cover).toContainEqual({ kind: 'signal_update', id: 'sg_2', update: 'ack' });
    const sent = cover.find((i) => i.kind === 'move' && i.mode === 'move');
    expect(sent?.kind).toBe('move');
    if (sent?.kind !== 'move') return;
    for (const id of sent.units) {
      const e = s.ents.find((u) => u.id === s.aliasTarget(armyOf(team), Number(id.slice(2))))!;
      e.x = centre;
      e.y = centre;
    }
    steps(g, TIERS.standard.period);
    expect(think()).toContainEqual({ kind: 'ascend', units: sent.units });
  });
});

describe('bots ask for support', () => {
  /** `team`'s depths seat with a Warden walled against a hostile trooper two tiles toward the map centre, seen by a scan. */
  const walled = (team: Team, options = {}) => {
    const g = createGame({ seed: 3, options });
    const s = g.sim;
    const warden = s.spawnUnit(armyOf(team), 'warden', 'depths');
    const foe = s.add('trooper', armyOf(enemyOf(team)), 'depths', warden.x + (team === 'nw' ? 2 : -2), warden.y);
    s.scan(armyOf(team), foe.x, foe.y);
    const seat = { team, role: 'depths' as const };
    const obs = g.observe(seat, 0);
    obs.entities.find((e) => e.id === g.entityId(team, warden.id))!.state = 'walled';
    return { g, s, warden, obs, seat };
  };

  it('a Depths Warden walled against enemies asks the Surface for troopers at its tile, mirrored', () => {
    const asks = DUEL.map((team) => {
      const { g, s, warden, obs, seat } = walled(team);
      const out = bot(g, team, 'depths').think(obs);
      const ask = out.find((i) => i.kind === 'signal');
      expect(ask).toMatchObject({ kind: 'signal', signal: { kind: 'request_support', to: 'surface', need: 'troops' } });
      for (const intent of out) if (intent.kind === 'signal') expect(g.apply(seat, intent, { source: 'bot' })).toEqual({ ok: true });
      const inbox = g.observe({ team, role: 'surface' }, 0).signals.inbox;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ from: 'depths', need: 'troops', state: 'submitted' });
      const entry = inbox[0]!;
      expect(entry.count).toBeGreaterThanOrEqual(1);
      expect(Math.hypot(entry.x! + 0.5 - warden.x, entry.y! + 0.5 - warden.y)).toBeLessThan(1);
      return { count: entry.count, x: tileAt(team, entry.x!, s.size), y: tileAt(team, entry.y!, s.size) };
    });
    expect(asks[1]).toEqual(asks[0]);
  });

  it('the Surface asks the Sky to capture a hostile island structure near its Spire (flak and turrets spare it), mirrored', () => {
    const asks = DUEL.map((team) => {
      const g = createGame({ seed: 3 });
      const s = g.sim;
      const spire = s.armies[armyOf(team)]!.spire.surface;
      const relay = s.add('relay', armyOf(enemyOf(team)), 'sky', spire.x + (team === 'nw' ? 8 : -8), spire.y + (team === 'nw' ? 8 : -8));
      relay.built = true;
      s.scan(armyOf(team), relay.x, relay.y);
      const seat = { team, role: 'surface' as const };
      const out = bot(g, team, 'surface').think(g.observe(seat, 0));
      const ask = out.find((i) => i.kind === 'signal');
      expect(ask).toMatchObject({ kind: 'signal', signal: { kind: 'request_support', to: 'sky', need: 'capture' } });
      if (ask?.kind !== 'signal' || ask.signal.kind !== 'request_support') return undefined;
      expect(Math.hypot(ask.signal.x! + 0.5 - relay.x, ask.signal.y! + 0.5 - relay.y)).toBeLessThan(1);
      return { x: tileAt(team, ask.signal.x!, s.size), y: tileAt(team, ask.signal.y!, s.size) };
    });
    expect(asks[1]).toEqual(asks[0]);
  });

  it.each(DUEL)('%s: with signals off bots neither ask nor answer, and nothing breaks', (team) => {
    const off = { signals: { enabled: false } };
    const { g, obs } = walled(team, off);
    expect(bot(g, team, 'depths').think(obs).some((i) => i.kind === 'signal' || i.kind === 'signal_update')).toBe(false);
    expect(request(g, team, 'depths', { to: 'surface', need: 'troops' })).toEqual({ ok: false, code: 'signal_refused' });
    // Even a request on the observation (none can exist) is left alone.
    const surface = g.observe({ team, role: 'surface' }, 0);
    const entry = { kind: 'request_support', id: 'sg_1', from: 'depths', to: 'surface', tick: 0, expires: toTicks(45), state: 'submitted', need: 'troops' } as Entry;
    surface.signals = { inbox: [entry], sent: [] };
    expect(bot(g, team, 'surface').think(surface).some((i) => i.kind === 'signal' || i.kind === 'signal_update')).toBe(false);
  });

  it('novice bots decline requests', () => {
    for (const team of DUEL) {
      const g = createGame({ seed: 3 });
      expect(request(g, team, 'surface', { to: 'orbit', need: 'scan', x: 20, y: 20 })).toEqual({ ok: true });
      expect(bot(g, team, 'orbit', 'novice').think(g.observe({ team, role: 'orbit' }, 0))).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'decline' });
    }
  });
});

describe('bot matches with team signals', () => {
  /** Every request each army's board showed, by id, with its last state seen; tiles turned into the nw frame. */
  const traffic = (options = {}): Record<Team, unknown[]> => {
    const seen: Record<Team, Map<string, Entry>> = { nw: new Map(), se: new Map() };
    let size = 0;
    playBotMatch({
      seed: 1, options, levels: { nw: 'standard', se: 'standard' }, maxTicks: toTicks(180),
      onTick: (g) => {
        size = g.sim.size;
        for (const team of DUEL) for (const e of board(g, team)) seen[team].set(e.id, e);
      },
    });
    const canon = (team: Team) => [...seen[team].values()].map((e) => ({
      ...e, ...(e.x === undefined ? {} : { x: tileAt(team, e.x, size) }), ...(e.y === undefined ? {} : { y: tileAt(team, e.y, size) }),
    }));
    return { nw: canon('nw'), se: canon('se') };
  };

  it('equal standard armies complete requests and exchange exactly mirrored signal traffic (3 min)', () => {
    const { nw, se } = traffic();
    expect(nw.some((e) => (e as Entry).state === 'completed')).toBe(true);
    expect(se).toEqual(nw);
  });

  it('with signals off a match sends no signal intents', () => {
    let signals = 0;
    playBotMatch({
      seed: 1, options: { signals: { enabled: false } }, levels: { nw: 'standard', se: 'standard' }, maxTicks: toTicks(90),
      onIntent: (_g, _seat, intent) => { if (intent.kind === 'signal' || intent.kind === 'signal_update') signals++; },
    });
    expect(signals).toBe(0);
  });
});

/** Wardens without troopers have left the post band by this long after the push is ready. */
const RAID_WITHIN = toTicks(40);

describe('the Warden push', () => {
  const distOf = (e: { x: number; y: number }, p: { x: number; y: number }): number => Math.hypot(e.x - p.x, e.y - p.y);

  it('without troopers a standard raid pair leaves the post and advances once the push is ready, mirrored', () => {
    const idle = { think: (): AgentCommandIntent[] => [] };
    const farthest: Record<Team, number> = { nw: 0, se: 0 };
    let early = 0;
    let troopersBelow = 0;
    const homes: Partial<Record<Team, { x: number; y: number }>> = {};
    playBotMatch({
      seed: 1, options: { terrain: 'ridges' }, levels: { nw: 'standard', se: 'standard' },
      seats: { nw: { surface: idle }, se: { surface: idle } }, maxTicks: TIERS.standard.wardenPushAt + RAID_WITHIN,
      onTick: (g) => {
        for (const team of DUEL) {
          const home = homes[team] ??= g.matchData({ team, role: 'depths' }).armies.find((a) => a.id === team)!.spireAt;
          for (const e of g.sim.ents) {
            if (e.dead || e.side !== armyOf(team) || e.plane !== 'depths') continue;
            if (e.kind === 'trooper') troopersBelow++;
            if (e.kind !== 'warden') continue;
            if (g.sim.tick < TIERS.standard.wardenPushAt) early = Math.max(early, distOf(e, home));
            else farthest[team] = Math.max(farthest[team], distOf(e, home));
          }
        }
      },
    });
    expect(troopersBelow).toBe(0);
    expect(early).toBeLessThanOrEqual(WARDEN_POST_MAX + WARDEN_AT);
    expect(farthest.nw).toBeGreaterThan(WARDEN_POST_MAX + WARDEN_AT);
    expect(farthest.se).toBe(farthest.nw);
  });

  it.each(DUEL)('%s: ready Wardens send a raid pair toward the centre; novice ones hold their post', (team) => {
    const g = createGame({ seed: 3 });
    const wardens = [0, 1].map(() => g.entityId(team, g.sim.spawnUnit(armyOf(team), 'warden', 'depths').id));
    const home = g.matchData({ team, role: 'depths' }).armies.find((a) => a.id === team)!.spireAt;
    const moves = (level: 'standard' | 'novice'): number[] => {
      const obs = g.observe({ team, role: 'depths' }, 0);
      obs.tick = TIERS.standard.wardenPushAt;
      return bot(g, team, 'depths', level).think(obs).flatMap((i) => (i.kind === 'move' && i.units.some((u) => wardens.includes(u)) ? [distOf(i, home)] : []));
    };
    const raid = moves('standard');
    expect(raid).toHaveLength(2);
    expect(Math.min(...raid)).toBeGreaterThan(WARDEN_POST_MAX + WARDEN_AT);
    expect(moves('novice').every((d) => d <= WARDEN_POST_MAX + WARDEN_AT)).toBe(true);
  });
});
