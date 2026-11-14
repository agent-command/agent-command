import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { CELL, OBS_GRID, TICK_RATE, observationSchema, type MatchOptions } from '../src/rules/contract.ts';
import { gridPosition } from '../src/util/math.ts';

const seat = { team: 'nw', role: 'depths' } as const;
const steps = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 6, options: { terrain: 'open', ...options } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, 2);
  return g;
}
function tapArena(options: MatchOptions = {}) {
  const g = arena(options);
  const s = g.sim;
  const c = 20 * s.size + 20, p = c + 1, stand = c - 1;
  s.magma.fill(0);
  s.magma[p] = 1;
  for (const at of [c, p, c + s.size, c - s.size]) { s.cells[at] = CELL.rock; s.holes[at] = 0; s.armies[0]!.group.known[at] = CELL.rock; }
  s.cells[stand] = s.armies[0]!.group.known[stand] = CELL.tunnel;
  s.armies[0]!.group.pocketKnown[p] = 1;
  s.armies[0]!.group.known[p] = CELL.magma;
  const digger = s.spawnUnit(0, 'digger', 'depths');
  digger.x = 19.5; digger.y = 20.5; digger.cell = stand;
  const intent = { kind: 'queue_add', item: 'geothermal', x: 20, y: 20, digger: g.entityId('nw', digger.id) } as const;
  return { g, s, c, p, digger, intent };
}

describe('geothermal fallback', () => {
  it('requires a known rock site beside a located sealed pocket, one tap per pocket', () => {
    const { g, s, p, intent } = tapArena();
    s.armies[0]!.group.pocketKnown[p] = 0;
    expect(g.apply(seat, intent).ok).toBe(false);
    s.armies[0]!.group.pocketKnown[p] = 1;
    expect(g.apply(seat, intent)).toEqual({ ok: true });
    expect(g.apply(seat, intent).ok).toBe(false);
    // Another cell of the same pocket must not provide a second tap slot.
    s.magma[p + s.size] = s.armies[0]!.group.pocketKnown[p + s.size] = 1;
    s.armies[0]!.group.known[p + s.size] = CELL.magma;
    s.cells[p + s.size] = CELL.rock;
    s.cells[p + s.size - 2] = s.armies[0]!.group.known[p + s.size - 2] = CELL.tunnel;
    expect(g.apply(seat, { ...intent, y: intent.y + 1 }).ok).toBe(false);
    steps(g, s.stats.geothermal.build + 4);
    expect(s.ents.filter(e => e.kind === 'geothermal' && !e.dead)).toHaveLength(1);
    expect(g.apply(seat, intent).ok).toBe(false);
    expect(s.cells[20 * s.size + 20]).toBe(CELL.rock);
  });

  it('builds without the root, bypasses Orbit and delivery, surges until the flood cools then stays spent', () => {
    const { g, s, p, intent } = tapArena({ economy: { baseEnergyCap: 0, minimumEnergyCap: 0 }, depths: { magmaCoolTime: 2 } });
    s.armies[0]!.spire.depths.hp = 0;
    s.armies[0]!.spire.orbit.hp = 0;
    s.armies[0]!.spire.sky.hp = 0;
    expect(g.apply(seat, intent)).toEqual({ ok: true });
    steps(g, s.stats.geothermal.build + 4);
    const tap = s.ents.find(e => e.kind === 'geothermal')!;
    expect(tap).toBeDefined();
    expect(g.observe(seat, 0).res).toMatchObject({ energyCap: 0, energyRate: 0.5, income: { depths: { energy: 0.5 } } });
    s.digCell(p, 1);
    steps(g, 1);
    expect(g.observe(seat, 0).res.energyRate).toBe(2);
    const coolAt = tap.coolAt;
    steps(g, coolAt - s.tick);
    expect(g.observe(seat, 0).res.energyRate).toBe(0);
    expect(tap.state).toBe('idle');
    expect(g.apply(seat, intent).ok).toBe(false);
  });

  it('uses match rates, gates taps while Orbit lives, refunds interrupted construction, and does not reveal a hidden breach at submission', () => {
    const { g, s, p, intent, digger } = tapArena({ economy: { geothermalHealthyRate: 0.25, geothermalRate: 0.75, geothermalSurgeMultiplier: 3 } });
    expect(g.apply(seat, intent)).toEqual({ ok: true });
    steps(g, 1);
    const before = s.armies[0]!.alloy;
    s.order(digger, { k: 'none' });
    steps(g, 1);
    expect(s.armies[0]!.alloy - before).toBeCloseTo(s.stats.geothermal.alloy + s.econ.spireAlloyRate / TICK_RATE);
    steps(g, s.stats.geothermal.build + 4);
    // A healthy Orbit segment holds taps to the top-up rate; the full fallback rate starts when it falls.
    expect(g.observe(seat, 0).res.energyRate).toBe(0.25);
    s.armies[0]!.spire.orbit.hp = 0; steps(g, 1);
    expect(g.observe(seat, 0).res.energyRate).toBe(0.75);
    s.digCell(p, 1); steps(g, 1);
    expect(g.observe(seat, 0).res.energyRate).toBe(2.25);
    // Unseen truth differs (the pocket already cooled); knowledge is unchanged. Submission and funding read knowledge
    // only, so both twins start alike; the digger finds out at the cell, and the entry is refunded and cancelled.
    const real = tapArena();
    const twin = tapArena();
    twin.s.magma[twin.p] = 0;
    for (const w of [real, twin]) expect(w.g.apply(seat, w.intent)).toEqual({ ok: true });
    const alloy = twin.s.armies[0]!.alloy;
    steps(real.g, 1);
    steps(twin.g, 1);
    // The digger already stands beside the cell, so funding and the finding land in the same tick.
    expect(real.s.armies[0]!.queue[0]?.started).toBe(true);
    expect(twin.s.armies[0]!.queue).toHaveLength(0);
    expect(twin.s.armies[0]!.events.find((e) => e.kind === 'queue_cancelled')).toMatchObject({ subject: 'geothermal', code: 'blocked' });
    expect(twin.s.armies[0]!.alloy).toBeCloseTo(alloy + s.econ.spireAlloyRate / TICK_RATE);
    steps(real.g, s.stats.geothermal.build + 4);
    expect(real.s.ents.filter((e) => e.kind === 'geothermal' && !e.dead)).toHaveLength(1);
  });
});

describe('segment-loss production and delivery', () => {
  it('retains relays and the minimum floor after Sky loss, including after Orbit loss', () => {
    const g = arena({ economy: { baseEnergyCap: 2, minimumEnergyCap: 1.25, relayEnergyCap: 3 } });
    const s = g.sim, t = s.armies[0]!;
    const island = s.ents.find(e => e.kind === 'island')!;
    s.setSide(island, 0);
    const relay = s.build(0, 'relay', island.x, island.y, 'sky');
    relay.built = true; relay.link = island.id; island.link = relay.id;
    for (let i = 0; i < 4; i++) {
      const solar = s.spawnUnit(0, 'solar', 'orbit');
      solar.x = s.size / 2 + 10 * Math.cos(s.sunAngle); solar.y = s.size / 2 + 10 * Math.sin(s.sunAngle);
    }
    steps(g, 1); expect(t.cap).toBe(5);
    t.spire.sky.hp = 0; steps(g, 1);
    expect(t.cap).toBe(4.25); expect(t.delivered).toBe(4.25);
    t.spire.orbit.hp = 0; steps(g, 1); expect(t.delivered).toBe(4.25);
    relay.hp = 0; steps(g, 2); expect(t.cap).toBe(1.25);
  });

  it('queues diggers only at own built Shafts while rootless, charges 50% extra and spawns there', () => {
    const g = arena({ stats: { digger: { alloy: 51, energy: 3, build: 0.1 } } });
    const s = g.sim, t = s.armies[0]!;
    const shaft = s.build(0, 'shaft', 12.5, 12.5, 'surface'); shaft.built = true;
    s.cells[12 * s.size + 12] = CELL.tunnel;
    const intent = { kind: 'queue_add', item: 'digger', producer: g.entityId('nw', shaft.id) } as const;
    expect(g.apply(seat, intent).ok).toBe(false);
    t.spire.depths.hp = 0;
    expect(g.apply(seat, { kind: 'queue_add', item: 'digger' }).ok).toBe(false);
    expect(g.apply(seat, intent)).toEqual({ ok: true });
    expect(g.observe(seat, 0).queue[0]).toMatchObject({ alloy: 77, energy: 5, producer: intent.producer });
    const beforeA = t.alloy, beforeE = t.energy;
    steps(g, 1);
    expect(t.alloy).toBeCloseTo(beforeA - 77 + s.econ.spireAlloyRate * s.econ.rootlessTrickle / TICK_RATE);
    expect(t.energy).toBeCloseTo(beforeE - 5);
    steps(g, 2);
    const digger = s.ents.find(e => !e.dead && e.kind === 'digger' && e.side === 0)!;
    expect(digger.plane).toBe('depths');
    // It appears at the Shaft (presented on the position grid), then heads for the Depths rally like any new unit.
    expect(g.events(seat, 0).find((e) => e.kind === 'produced' && e.subject === 'digger')).toMatchObject({ plane: 'depths', x: gridPosition(shaft.x, OBS_GRID, s.size), y: gridPosition(shaft.y, OBS_GRID, s.size) });
    expect(g.apply(seat, intent)).toEqual({ ok: true });
    steps(g, 1); shaft.hp = 0; steps(g, 1);
    expect(t.queue[0]?.reason).toBe('producer');
  });

  it('gives each Shaft an independent serial producer and refunds its actual surcharge', () => {
    const g = arena({ economy: { shaftDiggerMultiplier: 2 } });
    const s = g.sim, t = s.armies[0]!;
    t.spire.depths.hp = 0;
    const a = s.build(0, 'shaft', 12.5, 12.5, 'surface');
    const b = s.build(0, 'shaft', 15.5, 12.5, 'surface');
    a.built = b.built = true;
    for (const producer of [a, a, b]) expect(g.apply(seat, { kind: 'queue_add', item: 'digger', producer: g.entityId('nw', producer.id) })).toEqual({ ok: true });
    // One new commitment per allocation: the waiting entry at busy Shaft A must not starve idle Shaft B.
    steps(g, 2);
    expect(t.queue.map(q => q.started)).toEqual([true, false, true]);
    const paid = s.stats.digger.alloy * s.econ.shaftDiggerMultiplier;
    const before = t.alloy;
    expect(g.apply(seat, { kind: 'queue_cancel', entry: `q_${t.queue[0]!.id}` })).toEqual({ ok: true });
    expect(t.alloy - before).toBeCloseTo(paid * s.econ.queueRefund);
    steps(g, 1);
    expect(t.queue.map(q => q.started)).toEqual([true, true]);
  });

  it('attributes alloy and energy by plane identically in observations and views across root loss', () => {
    const { g, s, intent } = tapArena();
    expect(g.apply(seat, intent)).toEqual({ ok: true });
    steps(g, 10 * TICK_RATE);
    const obs = g.observe(seat, 0);
    expect(obs.res.income.surface.alloy).toBe(2);
    // Orbit is alive, so the tap runs at the healthy top-up rate.
    expect(obs.res.income.depths.energy).toBe(s.econ.geothermalHealthyRate);
    expect(g.view('nw').res.income).toEqual(obs.res.income);
    expect(validate(observationSchema, obs).ok).toBe(true);
    s.armies[0]!.spire.depths.hp = 0; steps(g, 10 * TICK_RATE);
    expect(g.observe(seat, 0).res.income.surface.alloy).toBe(1);
    expect(g.observe(seat, 0).res.income.depths.energy).toBe(s.econ.geothermalHealthyRate);
  });
});
