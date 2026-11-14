/**
 * The starters answer team signals (bots/signals.ts), mirrored for both duel armies: a teammate's request in a plane's
 * inbox gets an ack and the matching action intent through the headless signal board, and with the `signals.enabled`
 * match rule off no starter sends any signal intent.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { intentSchema, validate } from 'playerthree';
import { CELL, PLANES, STATS, toTicks, type ArmyId, type MatchData, type Observation, type Plane } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { manifest } from '../src/agent/manifest.ts';
import { DECIDING_STARTERS, knobDefault, periodOf } from './starter-policies.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import type { Ent } from '../src/sim/ent.ts';

const TEAMS = ['nw', 'se'] as const;
const wire = intentSchema(manifest);

/** A duel's armies are point mirrors: tile (x, y) of one is (size − 1 − x, size − 1 − y) of the other. */
const mirror = (team: ArmyId, x: number, y: number, size: number) => (team === 'nw' ? { x, y } : { x: size - 1 - x, y: size - 1 - y });

/** A plane's starter (deciding on its first call), initialized with its match data; each call returns schema-valid plain intents. */
function policy(role: Plane, data: MatchData): (obs: Observation) => AgentCommandIntent[] {
  const api = runInNewContext(`${DECIDING_STARTERS[role]}\n({init, think});`, { log() {} }) as { init(d: MatchData): void; think(o: Observation): AgentCommandIntent[] };
  api.init(data);
  return (obs) => {
    const intents = structuredClone(api.think(obs));
    for (const raw of intents) {
      const v = validate(wire, raw);
      expect(v.ok ? true : v).toBe(true);
    }
    return intents;
  };
}

/** A built, unsealed own Shaft near home (its landing opened, as the Depths seat would dig it), and funds. */
function withShaft(team: ArmyId): { g: AgentCommandGame; army: number; shaft: Ent } {
  // The Shaft lands on the cavern arm 14 tiles out, where seed 3's default lava channel and moat cut a piece of the arm
  // off from the root: without lava lakes the landing joins the cavern home and to the centre, which this fixture needs.
  const g = createGame({ seed: 3, options: { map: { params: { lavaLakes: { enabled: false } } } } });
  const s = g.sim;
  const army = slotOfArmyId(team, 2);
  s.armies[army]!.alloy = 5000;
  s.armies[army]!.energy = 5000;
  const at = (v: number): number => (team === 'nw' ? v : s.size - v);
  const shaft = s.build(army, 'shaft', at(14.5), at(14.5), 'surface');
  for (let i = 0; i <= STATS.shaft.build + VISION_EVERY; i++) g.step();
  const c = cellOfEnt(shaft, s.size) + (team === 'nw' ? 1 : -1);
  s.cells[c] = CELL.tunnel;
  s.armies[army]!.group.known[c] = CELL.tunnel;
  expect(shaft.built).toBe(true);
  expect(s.shaftSealed(army, shaft)).toBe(false);
  return { g, army, shaft };
}

/** `from` asks `to` through the game's headless board; returns the request id. */
function request(g: AgentCommandGame, team: ArmyId, from: Plane, signal: Record<string, unknown>): string {
  expect(g.apply({ team, role: from }, { kind: 'signal', signal: { kind: 'request_support', ...signal } } as AgentCommandIntent)).toEqual({ ok: true });
  const sent = g.observe({ team, role: from }, 0).signals.sent;
  return sent[sent.length - 1]!.id;
}

/** Applies a seat's intents (the answering `action` must be accepted); returns the board entry `id` afterwards. */
function applyAll(g: AgentCommandGame, team: ArmyId, role: Plane, intents: AgentCommandIntent[], id: string, action?: AgentCommandIntent) {
  for (const intent of intents) {
    const result = g.apply({ team, role }, intent);
    if (intent === action) expect(result).toEqual({ ok: true });
  }
  return g.view(team).signals.find((s) => s.id === id)!;
}

const ids = (intent: AgentCommandIntent | undefined): string[] => (intent && 'units' in intent ? intent.units as string[] : []);

describe.each(TEAMS)('example policies answer team signals (%s)', (team) => {
  it('Surface: troops asked by the Depths go down the own Shaft nearest the tile', () => {
    const { g, army, shaft } = withShaft(team);
    for (let i = 0; i < 6; i++) g.sim.spawnUnit(army, 'trooper', 'surface');
    const seat = { team, role: 'surface' } as const;
    const think = policy('surface', g.matchData(seat));
    const tile = { x: Math.floor(shaft.x), y: Math.floor(shaft.y) };
    const id = request(g, team, 'depths', { to: 'surface', need: 'troops', count: 3, ...tile });
    const obs = g.observe(seat, 0);
    const portal = obs.entities.find((e) => e.id === g.entityId(team, shaft.id))!;
    const out = think(obs);
    expect(out).toContainEqual({ kind: 'signal_update', id, update: 'ack' });
    const transfer = out.find((i) => i.kind === 'transfer' && i.to === 'depths' && i.x === portal.x && i.y === portal.y);
    expect(ids(transfer)).toHaveLength(3);
    expect(applyAll(g, team, 'surface', out, id, transfer)).toMatchObject({ state: 'working', by: 'surface' });
  });

  it('Depths: troops asked by the Surface come up the own Shaft nearest the tile', () => {
    const { g, army, shaft } = withShaft(team);
    for (let i = 0; i < 4; i++) g.sim.spawnUnit(army, 'trooper', 'depths');
    g.step();
    const seat = { team, role: 'depths' } as const;
    const think = policy('depths', g.matchData(seat));
    const id = request(g, team, 'surface', { to: 'depths', need: 'troops', count: 2, x: Math.floor(shaft.x), y: Math.floor(shaft.y) });
    const obs = g.observe(seat, 0);
    const portal = obs.entities.find((e) => e.id === g.entityId(team, shaft.id))!;
    const out = think(obs);
    expect(out).toContainEqual({ kind: 'signal_update', id, update: 'ack' });
    const transfer = out.find((i) => i.kind === 'transfer' && i.to === 'surface' && i.x === portal.x && i.y === portal.y);
    expect(ids(transfer)).toHaveLength(2);
    expect(applyAll(g, team, 'depths', out, id, transfer)).toMatchObject({ state: 'working', by: 'depths' });
  });

  it('Sky: air_cover asked by the Surface sends interceptors to the tile', () => {
    const g = createGame({ seed: 3 });
    const army = slotOfArmyId(team, 2);
    const spawned = Array.from({ length: 4 }, () => g.entityId(team, g.sim.spawnUnit(army, 'interceptor', 'sky').id));
    g.step();
    const seat = { team, role: 'sky' } as const;
    const think = policy('sky', g.matchData(seat));
    const tile = mirror(team, 18, 20, g.sim.size);
    const id = request(g, team, 'surface', { to: 'sky', need: 'air_cover', count: 2, ...tile });
    const obs = g.observe(seat, 0);
    const out = think(obs);
    expect(out).toContainEqual({ kind: 'signal_update', id, update: 'ack' });
    // The cover is any two of our interceptors (the starting ones may stand nearer the tile than the spawned ones).
    const ours = new Set(obs.entities.filter((e) => e.side === team && e.kind === 'interceptor').map((e) => e.id));
    expect(spawned.every((u) => ours.has(u))).toBe(true);
    // Weather routing may add waypoints: the last order for the cover lands on the tile, fighting.
    const orders = out.filter((i) => i.kind === 'move' && ids(i).length === 2 && ids(i).every((u) => ours.has(u)));
    expect(orders.at(-1)).toMatchObject({ x: tile.x + 0.5, y: tile.y + 0.5, mode: 'fight' });
    expect(applyAll(g, team, 'sky', out, id, orders.at(-1))).toMatchObject({ state: 'working', by: 'sky' });
  });

  it('Surface: a hostile island structure near the Spire asks the Sky to capture it (flak and turrets spare it)', () => {
    const g = createGame({ seed: 3 });
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const spire = s.armies[army]!.spire.surface;
    const d = team === 'nw' ? 8 : -8;
    const relay = s.add('relay', slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2), 'sky', spire.x + d, spire.y + d);
    relay.built = true;
    s.scan(army, relay.x, relay.y);
    const seat = { team, role: 'surface' } as const;
    const out = policy('surface', g.matchData(seat))(g.observe(seat, 0));
    expect(out).toContainEqual({ kind: 'signal', signal: { kind: 'request_support', to: 'sky', need: 'capture', x: Math.floor(relay.x), y: Math.floor(relay.y) } });
  });

  it('Orbit: a scan asked by the Depths fires at the tile and completes', () => {
    const g = createGame({ seed: 3 });
    const army = slotOfArmyId(team, 2);
    g.sim.armies[army]!.energy = 5000;
    g.step();
    const seat = { team, role: 'orbit' } as const;
    const think = policy('orbit', g.matchData(seat));
    const tile = mirror(team, 16, 21, g.sim.size);
    const id = request(g, team, 'depths', { to: 'orbit', need: 'scan', ...tile });
    const out = think(g.observe(seat, 0));
    const updates = out.filter((i) => i.kind === 'signal_update');
    expect(updates).toEqual([{ kind: 'signal_update', id, update: 'ack' }, { kind: 'signal_update', id, update: 'done' }]);
    expect(out.filter((i) => i.kind === 'scan')).toEqual([{ kind: 'scan', x: tile.x + 0.5, y: tile.y + 0.5 }]);
    expect(applyAll(g, team, 'orbit', out, id, out.find((i) => i.kind === 'scan'))).toMatchObject({ state: 'completed', by: 'orbit' });
  });

  it('Orbit: an escort asked by the Sky moves Bastions to the tile', () => {
    const g = createGame({ seed: 3 });
    const army = slotOfArmyId(team, 2);
    const bastions = Array.from({ length: 3 }, () => g.entityId(team, g.sim.spawnUnit(army, 'bastion', 'orbit').id));
    g.step();
    const seat = { team, role: 'orbit' } as const;
    const think = policy('orbit', g.matchData(seat));
    const tile = mirror(team, 20, 18, g.sim.size);
    const id = request(g, team, 'sky', { to: 'orbit', need: 'escort', count: 2, ...tile });
    const out = think(g.observe(seat, 0));
    expect(out).toContainEqual({ kind: 'signal_update', id, update: 'ack' });
    const escort = out.find((i) => i.kind === 'move' && i.x === tile.x + 0.5 && i.y === tile.y + 0.5);
    expect(escort).toMatchObject({ mode: 'fight' });
    expect(ids(escort)).toHaveLength(2);
    expect(ids(escort).every((u) => bastions.includes(u))).toBe(true);
    expect(applyAll(g, team, 'orbit', out, id, escort)).toMatchObject({ state: 'working', by: 'orbit' });
    // Once the escort stands at the tile, the next decision (a period later) reports the request done.
    for (const e of g.sim.ents) if (e.side === army && ids(escort).includes(g.entityId(team, e.id))) { e.x = tile.x + 0.5; e.y = tile.y + 0.5; }
    for (let i = 0; i < periodOf('orbit'); i++) g.step();
    const next = think(g.observe(seat, 0));
    expect(next).toContainEqual({ kind: 'signal_update', id, update: 'done' });
    expect(applyAll(g, team, 'orbit', next, id)).toMatchObject({ state: 'completed', by: 'orbit' });
  });

  it('with signals.enabled false no policy sends a signal intent, even with a request in its inbox', () => {
    const NEED: Record<Plane, string> = { depths: 'troops', surface: 'flak', sky: 'bombers', orbit: 'scan' };
    for (const signals of [true, false]) {
      const g = createGame({ seed: 3, options: { signals: { enabled: signals } } });
      g.step();
      for (const role of PLANES) {
        const seat = { team, role } as const;
        const think = policy(role, g.matchData(seat));
        const obs = g.observe(seat, 0);
        const tile = mirror(team, 20, 20, g.sim.size);
        obs.signals.inbox = [{ kind: 'request_support', id: 'sg_1', from: role === 'surface' ? 'sky' : 'surface', to: role, tick: obs.tick, expires: obs.tick + toTicks(45), state: 'submitted', need: NEED[role], ...tile } as Observation['signals']['inbox'][number]];
        const sent = think(obs).filter((i) => i.kind === 'signal' || i.kind === 'signal_update');
        // On, the request is at least answered (declined without units); off, nothing.
        if (signals) expect(sent.length).toBeGreaterThan(0);
        else expect(sent).toEqual([]);
      }
    }
  });
});

/** The Depths starter's Warden push (knobs wardenPushAt, troopersDown); tiles the joined troopers must gain toward the centre. */
const PUSH_ADVANCE = 4;
const PUSH_AT = knobDefault('depths', 'wardenPushAt');
const PUSH_TROOPERS = knobDefault('depths', 'troopersDown');

describe.each(TEAMS)('the Warden push loop in the example policies (%s)', (team) => {
  it('Depths: at push time the Wardens ask the Surface for the missing troopers and advance without them', () => {
    const g = createGame({ seed: 3 });
    const army = slotOfArmyId(team, 2);
    const wardens = Array.from({ length: 2 }, () => g.entityId(team, g.sim.spawnUnit(army, 'warden', 'depths').id));
    g.sim.tick = PUSH_AT;
    g.step();
    const seat = { team, role: 'depths' } as const;
    const think = policy('depths', g.matchData(seat));
    const obs = g.observe(seat, 0);
    const out = think(obs);
    const asks = out.filter((i) => i.kind === 'signal');
    expect(asks).toEqual([{ kind: 'signal', signal: expect.objectContaining({ kind: 'request_support', to: 'surface', need: 'troops', count: PUSH_TROOPERS }) }]);
    // The pair heads out toward the centre (no hostile digger in sight, no linked tunnel yet), fighting on the way.
    const advance = out.find((i) => i.kind === 'move' && ids(i).some((u) => wardens.includes(u)));
    expect(advance).toMatchObject({ mode: 'fight' });
    const centre = { x: g.sim.size / 2, y: g.sim.size / 2 };
    const from = obs.entities.find((e) => e.id === wardens[0])!;
    const to = advance as { x: number; y: number };
    expect(Math.hypot(to.x - centre.x, to.y - centre.y)).toBeLessThan(Math.hypot(from.x - centre.x, from.y - centre.y));
  });

  it('Surface: a troops request with no Shaft yet is taken and kept working while the Shaft is queued', () => {
    const g = createGame({ seed: 3 });
    const army = slotOfArmyId(team, 2);
    g.sim.armies[army]!.alloy = 5000;
    g.sim.armies[army]!.energy = 5000;
    for (let i = 0; i < 6; i++) g.sim.spawnUnit(army, 'trooper', 'surface');
    g.sim.tick = PUSH_AT;
    g.step();
    const seat = { team, role: 'surface' } as const;
    const think = policy('surface', g.matchData(seat));
    const id = request(g, team, 'depths', { to: 'surface', need: 'troops', count: PUSH_TROOPERS, ...mirror(team, 8, 8, g.sim.size) });
    const out = think(g.observe(seat, 0));
    expect(out.filter((i) => i.kind === 'signal_update')).toEqual([{ kind: 'signal_update', id, update: 'ack' }]);
    expect(out.some((i) => i.kind === 'queue_add' && i.item === 'shaft')).toBe(true);
    expect(out.some((i) => i.kind === 'transfer')).toBe(false);
    expect(applyAll(g, team, 'surface', out, id)).toMatchObject({ state: 'working', by: 'surface' });
    for (let i = 0; i < periodOf('surface'); i++) g.step();
    const later = think(g.observe(seat, 0)).filter((i) => i.kind === 'signal_update');
    expect(later).toEqual([]);
    expect(g.view(team).signals.find((s) => s.id === id)).toMatchObject({ state: 'working' });
  });

  it('end to end: the Depths asks, the Surface sends troopers down its Shaft, and the push heads for the centre', () => {
    const { g, army } = withShaft(team);
    for (let i = 0; i < 2; i++) g.sim.spawnUnit(army, 'warden', 'depths');
    for (let i = 0; i < 6; i++) g.sim.spawnUnit(army, 'trooper', 'surface');
    g.sim.tick = PUSH_AT;
    g.step();
    const seats = (['depths', 'surface'] as const).map((role) => ({ seat: { team, role }, think: policy(role, g.matchData({ team, role })) }));
    const centre = { x: g.sim.size / 2, y: g.sim.size / 2 };
    const below = () => g.sim.ents.filter((e) => e.side === army && e.kind === 'trooper' && e.plane === 'depths' && !e.dead);
    let arrivedAt = -1, closest = Infinity, start = Infinity;
    for (let t = 0; t < toTicks(120); t++) {
      // Both seats decide twice per game second, as the policy host calls them.
      if (g.tick % toTicks(0.5) === 0) for (const { seat, think } of seats) for (const intent of think(g.observe(seat, 0))) g.apply(seat, intent, { source: 'policy' });
      g.step();
      const down = below();
      if (arrivedAt < 0 && down.length >= PUSH_TROOPERS) {
        arrivedAt = g.tick;
        start = Math.min(...down.map((e) => Math.hypot(e.x - centre.x, e.y - centre.y)));
      }
      if (arrivedAt >= 0) closest = Math.min(closest, ...down.map((e) => Math.hypot(e.x - centre.x, e.y - centre.y)));
      if (arrivedAt >= 0 && start - closest >= PUSH_ADVANCE) break;
    }
    expect(arrivedAt).toBeGreaterThanOrEqual(0);
    expect(start - closest).toBeGreaterThanOrEqual(PUSH_ADVANCE);
    expect(g.view(team).signals).toContainEqual(expect.objectContaining({ from: 'depths', need: 'troops', state: 'completed', by: 'surface' }));
  });
});
