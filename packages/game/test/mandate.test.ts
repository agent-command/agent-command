import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createPlayerThreeHost, replayMatch } from 'playerthree/host';
import { createGame, definition } from '../src/agent/adapter.ts';
import { CELL, SURFACE, observationSchema, viewSchema, type SeatMandate } from '../src/rules/contract.ts';
import { manifest } from '../src/agent/manifest.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2);

const mandate = (limits?: SeatMandate['limits']): SeatMandate => ({
  autonomy: 'autonomous', directive: { stance: 'economy' }, whenAbsent: 'policy',
  ...(limits === undefined ? {} : { limits }),
});

describe('seat mandates', () => {
  it('exposes current mandates in observations and view seats without sharing mutable owner input or snapshots', () => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'orbit' } as const;
    const input = mandate({ asteroidDrops: false });
    input.autonomy = 'supervised';
    input.whenAbsent = 'hold';
    input.directive = { stance: 'support', focusX: 12, focusY: 15 };
    g.setSeatInfo(seat, { controller: 'agent', mandate: input });
    const expected = structuredClone(input);
    input.directive.stance = 'attack';
    input.limits!.asteroidDrops = true;
    const obs = g.observe(seat, 0);
    const view = g.view('nw');
    expect(obs.mandate).toEqual(expected);
    expect(view.seats.find((s) => s.role === 'orbit')).toEqual({ role: 'orbit', controller: 'agent', mandate: expected });
    expect(validate(observationSchema, obs).ok).toBe(true);
    expect(validate(viewSchema, view).ok).toBe(true);
    obs.mandate.directive.stance = 'defend';
    obs.mandate.limits!.asteroidDrops = true;
    view.seats.find((s) => s.role === 'orbit')!.mandate.whenAbsent = 'bot';
    expect(g.observe(seat, 0).mandate).toEqual(expected);
    expect(g.observe({ team: 'se', role: 'orbit' }, 0).mandate).toEqual(mandate());
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).mandate).toEqual(mandate());
    g.setSeatInfo(seat, { controller: 'human', mandate: mandate() });
    expect(g.observe(seat, 0).mandate).toEqual(mandate());
    expect(g.view('nw').seats.find((s) => s.role === 'orbit')!.controller).toBe('human');
  });

  it('accepts optional boolean house rules and rejects unknown or nonboolean limits', () => {
    for (const limits of [{}, { asteroidDrops: false }, { collapses: true }, { asteroidDrops: true, collapses: false }]) {
      expect(validate(manifest.limits, limits).ok).toBe(true);
    }
    expect(validate(manifest.limits, { asteroidDrops: 'false' }).ok).toBe(false);
    expect(validate(manifest.limits, { unknown: false }).ok).toBe(false);
  });

  it.each([undefined, {}, { asteroidDrops: true }])('allows asteroid drops with limits %j', (limits) => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'orbit' } as const;
    const tug = g.sim.spawnUnit(BLUE, 'tug', 'orbit');
    const rock = g.sim.add('asteroid', BLUE, 'orbit', 12, 12);
    tug.link = rock.id;
    rock.link = tug.id;
    rock.state = 'towed';
    g.setSeatInfo(seat, { controller: 'agent', mandate: mandate(limits) });
    expect(g.apply(seat, { kind: 'deorbit', units: [g.entityId('nw', tug.id)], x: 12, y: 12 })).toEqual({ ok: true });
    expect(rock.state).toBe('falling');
  });

  it('blocks an entire drop group atomically, then permits it after the owner removes the limit', () => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'orbit' } as const;
    const pairs = [0, 1].map(() => {
      const tug = g.sim.spawnUnit(BLUE, 'tug', 'orbit');
      const rock = g.sim.add('asteroid', BLUE, 'orbit', 12, 12);
      tug.link = rock.id;
      rock.link = tug.id;
      rock.state = 'towed';
      return { tug, rock };
    });
    const drop = { kind: 'deorbit', units: pairs.map(({ tug }) => g.entityId('nw', tug.id)), x: 12, y: 12 } as const;
    g.setSeatInfo(seat, { controller: 'agent', mandate: mandate({ asteroidDrops: false }) });
    expect(g.apply(seat, drop)).toEqual({ ok: false, code: 'mandate_limit' });
    for (const { tug, rock } of pairs) {
      expect(tug.link).toBe(rock.id);
      expect(rock.link).toBe(tug.id);
      expect(rock.state).toBe('towed');
    }
    expect(g.observe(seat, 0).impacts).toEqual([]);
    g.setSeatInfo(seat, { controller: 'agent', mandate: mandate() });
    expect(g.apply(seat, drop)).toEqual({ ok: true });
    expect(g.observe(seat, 0).impacts).toHaveLength(2);
  });

  it.each([SURFACE.ground, SURFACE.fault])('blocks direct and queued charges under terrain %i, without changing orders', (terrain) => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'depths' } as const;
    const sapper = g.sim.spawnUnit(BLUE, 'sapper', 'depths');
    sapper.x = 10.5;
    sapper.y = 10.5;
    const c = 10 * 48 + 10;
    g.sim.cells[c] = CELL.tunnel;
    g.sim.armies[BLUE]!.group.known[c] = CELL.tunnel;
    g.sim.terrain[c] = terrain;
    g.setSeatInfo(seat, { controller: 'bot', mandate: mandate({ collapses: false }) });
    const before = structuredClone(sapper.order);
    for (const queue of [false, true]) {
      expect(g.apply(seat, { kind: 'undermine', units: [g.entityId('nw', sapper.id)], x: 10, y: 10, queue })).toEqual({ ok: false, code: 'mandate_limit' });
      expect(sapper.order).toEqual(before);
    }
    g.step();
    expect(g.observe(seat, 0).charges).toEqual([]);
    for (const limits of [{ collapses: true }, {}, undefined]) {
      g.setSeatInfo(seat, { controller: 'bot', mandate: mandate(limits) });
      expect(g.apply(seat, { kind: 'undermine', units: [g.entityId('nw', sapper.id)], x: 10, y: 10 })).toEqual({ ok: true });
    }
    g.step();
    expect(g.observe(seat, 0).charges).toHaveLength(1);
  });
});

describe('scheduled build orders', () => {
  it('executes a timed production sequence and records mandates and inputs for replay', async () => {
    const host = createPlayerThreeHost({ definition });
    try {
      const match = host.createMatch({ seed: 3, realtime: false, teams: ['nw', 'se'], botLevel: { nw: 'idle', se: 'idle' }, controllers: { nw: { surface: 'agent' } } });
      const agent = host.seatControl(match.mintSeatToken('nw', 'surface'))!;
      const ownerMandate = mandate({ collapses: false });
      match.setMandate('nw', 'surface', ownerMandate);
      const produce = { kind: 'queue_add', item: 'trooper' };
      expect(await agent.sequence({ steps: [{ in: 0, intents: [produce] }, { in: 2, intents: [produce] }] })).toMatchObject({ ok: true });
      await match.step(2);
      // Replay v2 entries carry the trusted intent source (PlayerThree): this agent seat's sequence is 'agent'.
      expect(match.replay().entries.filter((e) => e[3] === 'intent')).toEqual([[0, 'nw', 'surface', 'intent', produce, 'agent']]);
      await match.step();
      const replay = match.replay();
      expect(replay.entries.filter((e) => e[3] === 'intent')).toEqual([
        [0, 'nw', 'surface', 'intent', produce, 'agent'], [2, 'nw', 'surface', 'intent', produce, 'agent'],
      ]);
      expect(replay.entries).toContainEqual([0, 'nw', 'surface', 'seat', 'agent', ownerMandate]);
      const replayed = replayMatch(definition, replay);
      expect(replayed.outcomes).toEqual(replay.outcomes);
      expect(replayed.adapter.observe({ team: 'nw', role: 'surface' }, 0, ['surface']).mandate).toEqual(ownerMandate);
      expect(replayed.adapter.observe({ team: 'nw', role: 'surface' }, 0, ['surface'])).toEqual(await agent.observe());
    } finally {
      host.dispose();
    }
  });

  it('rejects overlong, distant or too closely spaced plans without scheduling a partial build order', async () => {
    const host = createPlayerThreeHost({ definition });
    try {
      const match = host.createMatch({ seed: 3, realtime: false, teams: ['nw', 'se'], botLevel: { nw: 'idle', se: 'idle' }, controllers: { nw: { surface: 'agent' } } });
      const agent = host.seatControl(match.mintSeatToken('nw', 'surface'))!;
      const step = (offset: number) => ({ in: offset, intents: [{ kind: 'queue_add', item: 'trooper' }] });
      for (const steps of [Array.from({ length: 17 }, (_, i) => step(i * 2)), [step(0), step(1201)], [step(0), step(1)]]) {
        expect(await agent.sequence({ steps })).toMatchObject({ ok: false });
      }
      await match.step(3);
      expect(match.replay().entries.filter((e) => e[3] === 'intent')).toEqual([]);
      expect(await agent.sequence({ steps: [step(0), step(1200)] })).toMatchObject({ ok: true });
      expect(await agent.sequence({ steps: [] })).toMatchObject({ ok: true });
      await match.step();
      expect(match.replay().entries.filter((e) => e[3] === 'intent')).toEqual([]);
    } finally {
      host.dispose();
    }
  });
});
