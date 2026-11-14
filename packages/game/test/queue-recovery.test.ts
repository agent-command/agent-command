import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createPlayerThreeHost, replayMatch } from 'playerthree/host';
import { createGame, definition } from '../src/agent/adapter.ts';
import { DECIDING_STARTERS } from './starter-policies.ts';
import { createBot } from '../src/bots/bots.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { Ctx } from '../src/bots/context.ts';
import { STATS, toTicks, unpackTerrain, type ArmyId, type MatchData, type Observation, type Plane } from '../src/rules/contract.ts';

type Mode = 'policy' | 'standard' | 'veteran';
/** A seat's commander: a starter that decides on a fresh instance's first call, or a built-in bot. */
function commander(mode: Mode, role: Plane, data: MatchData) {
  const driver = mode === 'policy'
    ? runInNewContext(`${DECIDING_STARTERS[role]}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] }
    : createBot('nw', role, mode);
  driver.init?.(data);
  return driver;
}

const additions = (out: AgentCommandIntent[]) => out.filter((i): i is Extract<AgentCommandIntent, { kind: 'queue_add' }> => i.kind === 'queue_add');

for (const source of ['agent', 'policy', 'bot', 'fallback'] as const) it(`${source} can insert into its own lane without disturbing paid work in another lane`, () => {
  const game = createGame({ seed: 3 });
  const seat = { team: 'nw', role: 'depths' } as const;
  game.sim.armies[0]!.alloy = game.sim.armies[0]!.energy = 1000;
  expect(game.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'tank' }, { source: 'bot' })).toEqual({ ok: true });
  game.step();
  expect(game.observe(seat, 0).queue[0]).toMatchObject({ item: 'tank', status: 'building', automatic: true });
  expect(game.apply(seat, { kind: 'queue_add', item: 'digger', index: 0 }, { source })).toEqual({ ok: true });
  expect(game.observe(seat, 0).queue.map(q => q.item)).toEqual(['digger', 'tank']);
  expect(game.observe(seat, 0).queue.find(q => q.item === 'tank')).toMatchObject({ status: 'building', paid: true, automatic: true });
});

describe('verified worker recovery allocation', () => {
  function workerless(team: ArmyId) {
    const game = createGame({ seed: 3 }), sim = game.sim, army = sim.armyIndex(team), bank = sim.armies[army]!;
    for (const e of sim.ents) if (e.side === army && e.kind === 'digger') sim.damage(e, e.hp, army === 0 ? 1 : 0);
    bank.alloy = 0; bank.energy = 1000;
    return { game, sim, army, bank };
  }

  it.each(['nw', 'se'] as const)('%s: requested recovery is capped at one fifth while four normal lanes demand alloy', team => {
    const { game, sim, army, bank } = workerless(team);
    for (const [role, item] of [['depths', 'sapper'], ['surface', 'tank'], ['sky', 'bomber'], ['orbit', 'lancer']] as const)
      expect(game.apply({ team, role }, { kind: 'queue_add', item })).toEqual({ ok: true });
    expect(game.apply({ team, role: 'depths' }, { kind: 'queue_add', item: 'digger' })).toEqual({ ok: true });
    const recovery = bank.queue.find(e => e.item === 'digger')!;
    for (let i = 1; i <= 4; i++) {
      bank.alloy += 50;
      sim.allocateQueue(army);
      expect(bank.queue.filter(e => e.recovery)).toEqual([recovery]);
      expect(recovery.heldAlloy).toBe(10 * i);
      expect(bank.queue.filter(e => !e.recovery).map(e => e.heldAlloy)).toEqual([10 * i, 10 * i, 10 * i, 10 * i]);
      expect(bank.queue.reduce((sum, e) => sum + e.heldAlloy, 0)).toBe(bank.alloy);
      const obs = game.observe({ team, role: 'depths' }, 0);
      expect(obs.res.recoveryAlloy).toBe(10 * i);
      expect(obs.res.freeAlloy).toBe(0);
      expect(obs.queue.find(e => e.item === 'digger')).toMatchObject({ recovery: true, next: false, paid: false, heldAlloy: 10 * i });
    }
    const held = bank.queue.map(e => e.heldAlloy);
    for (let i = 0; i < 20; i++) sim.allocateQueue(army);
    expect(bank.queue.map(e => e.heldAlloy)).toEqual(held);
  });

  it('uses otherwise idle resources for requested recovery but never creates an unrequested worker', () => {
    const { game, sim, army, bank } = workerless('nw');
    bank.alloy = STATS.digger.alloy;
    sim.allocateQueue(army);
    expect(bank.queue).toEqual([]);
    expect(sim.available(army, 'alloy')).toBe(STATS.digger.alloy);
    expect(game.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_add', item: 'digger' })).toEqual({ ok: true });
    sim.updateProduction();
    expect(bank.queue[0]).toMatchObject({ item: 'digger', started: true, heldAlloy: 0 });
    expect(game.observe({ team: 'nw', role: 'depths' }, 0).queue[0]).toMatchObject({ paid: true, next: false, recovery: false });
    expect(bank.alloy).toBe(0);
    expect(sim.viableWorkers(army)).toBe(1);
  });

  it('counts paid replacements toward the two-worker target, but not a destroyed production route', () => {
    const { game, sim, army, bank } = workerless('nw');
    const first = sim.add('shaft', army, 'surface', 12, 12);
    const second = sim.add('shaft', army, 'surface', 16, 12);
    bank.spire.depths.hp = 0;
    bank.alloy = 1000;
    const seat = { team: 'nw', role: 'depths' } as const;
    expect(game.apply(seat, { kind: 'queue_add', item: 'digger', producer: game.entityId('nw', first.id) })).toEqual({ ok: true });
    expect(game.apply(seat, { kind: 'queue_add', item: 'digger', producer: game.entityId('nw', second.id) })).toEqual({ ok: true });
    expect(game.apply(seat, { kind: 'queue_add', item: 'digger', producer: game.entityId('nw', second.id) })).toEqual({ ok: true });
    game.step();
    game.step();
    expect(bank.queue.filter(e => e.started)).toHaveLength(2);
    expect(sim.ents.filter(e => !e.dead && e.side === army && e.kind === 'digger')).toHaveLength(0);
    expect(sim.viableWorkers(army)).toBe(2);
    sim.allocateQueue(army);
    expect(bank.queue.some(e => e.recovery)).toBe(false);
    sim.damage(first, first.hp, 1);
    sim.allocateQueue(army);
    expect(sim.viableWorkers(army)).toBe(1);
    expect(bank.queue[2]).toMatchObject({ started: false, recovery: true });
    sim.updateProduction();
    expect(game.observe(seat, 0).queue[0]).toMatchObject({ paid: true, status: 'blocked', reason: 'producer' });
  });

  it('keeps recovery supply open and counts paid workers before ordinary admissions start', () => {
    const { game, sim, army, bank } = workerless('nw');
    // Finalize worker deaths before fixing the remaining supply headroom.
    game.step();
    bank.alloy = 1000;
    bank.pop = sim.econ.popCap - 2;
    const first = sim.add('shaft', army, 'surface', 12, 12);
    const second = sim.add('shaft', army, 'surface', 16, 12);
    bank.spire.depths.hp = 0;
    expect(game.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
    expect(game.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_add', item: 'digger', producer: game.entityId('nw', first.id) })).toEqual({ ok: true });
    expect(game.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_add', item: 'digger', producer: game.entityId('nw', second.id) })).toEqual({ ok: true });
    game.step();
    game.step();
    expect(bank.queue.filter(e => e.started).map(e => e.item)).toEqual(['digger', 'digger']);
    expect(game.observe({ team: 'nw', role: 'surface' }, 0).queue[0]).toMatchObject({ item: 'trooper', paid: false, reason: 'pop_cap' });
    expect(sim.viableWorkers(army)).toBe(2);
    expect(bank.pop).toBe(sim.econ.popCap - 2);
  });
});

it('enforces seat production and owner priority through the real host, adapter and replay', async () => {
  const host = createPlayerThreeHost({ definition });
  try {
    const human = { depths: 'human', surface: 'human', sky: 'human', orbit: 'human' } as const;
    const match = host.createMatch({ seed: 3, realtime: false, teams: ['nw', 'se'], controllers: { nw: { ...human, depths: 'bot' }, se: human } });
    const seat = { team: 'nw', role: 'depths' } as const;
    const owner = match.seat(seat.team, seat.role);
    const agent = host.seatControl(match.mintSeatToken(seat.team, seat.role))!;
    expect(await owner.act([{ kind: 'queue_add', item: 'sapper' }])).toEqual([{ ok: true }]);
    match.setController(seat.team, seat.role, 'agent');
    const before = (await owner.observe()) as Observation;
    expect(await agent.act([
      { kind: 'queue_add', item: 'tank' },
      { kind: 'queue_cancel', entry: 'q_1' },
      { kind: 'queue_move', entry: 'q_1', index: 0 },
    ])).toEqual([
      { ok: false, code: 'game', gameCode: 'wrong_plane' },
      { ok: false, code: 'game', gameCode: 'invalid_target' },
      { ok: false, code: 'game', gameCode: 'invalid_target' },
    ]);
    const after = (await owner.observe()) as Observation;
    expect(after.queue).toEqual(before.queue);
    expect(after.res).toEqual(before.res);
    expect(await agent.act([{ kind: 'queue_add', item: 'sapper' }])).toEqual([{ ok: true }]);
    expect((await owner.policyDeploy({ runtime: 'js', code: 'function think(){return [{kind:"queue_add",item:"tank"},{kind:"queue_cancel",entry:"q_1"},{kind:"queue_cancel",entry:"q_2"},{kind:"queue_add",item:"warden"}];}' })).ok).toBe(true);
    await match.step(1);
    const queue = ((await owner.observe()) as Observation).queue;
    expect(queue.map(q => ({ item: q.item, byCtl: q.byCtl, automatic: q.automatic }))).toEqual([
      { item: 'sapper', byCtl: 'human', automatic: undefined },
      { item: 'sapper', byCtl: 'agent', automatic: undefined },
      { item: 'warden', byCtl: 'agent', automatic: true },
    ]);
    const replay = match.replay();
    // Rejected cross-plane production and cancellations retain their source, so replay enforces the same boundary.
    expect(replay.entries.filter(e => e[3] === 'intent').map(e => e[5])).toEqual(['owner', 'agent', 'agent', 'agent', 'agent', 'policy', 'policy', 'policy', 'policy']);
    expect(replayMatch(definition, replay).adapter.observe(seat, 0, []).queue).toEqual(queue);
  } finally {
    host.dispose();
  }
});

for (const mode of ['policy', 'standard', 'veteran'] as const) describe(`shared queue recovery: ${mode}`, () => {
  it('requests one real replacement without surplus and deduplicates pending work', () => {
    const game = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'depths' } as const;
    const data = game.matchData(seat);
    for (const e of game.sim.ents) if (e.side === 0 && e.kind === 'digger') game.sim.damage(e, e.hp, 1);
    game.sim.armies[0]!.alloy = 0;
    game.sim.armies[0]!.energy = 1000;
    expect(game.apply(seat, { kind: 'queue_add', item: 'sapper' }, { source: 'agent' })).toEqual({ ok: true });
    const replacement = additions(commander(mode, seat.role, data).think(game.observe(seat, 0))).filter(i => i.item === 'digger');
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.ifAffordable).not.toBe(true);
    expect(game.apply(seat, replacement[0]!, { source: mode === 'policy' ? 'policy' : 'bot' })).toEqual({ ok: true });
    expect(additions(commander(mode, seat.role, data).think(game.observe(seat, 0))).filter(i => i.item === 'digger')).toHaveLength(0);
  });

  it('does not replace a sheltered bomber whose fleet cap is already met', () => {
    const game = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'sky' } as const;
    const data = game.matchData(seat);
    for (let i = 0; i < 12; i++) game.sim.spawnUnit(0, 'interceptor', 'sky');
    for (let i = 0; i < 8; i++) game.sim.spawnUnit(0, 'bomber', 'sky');
    const obs = game.observe(seat, 0);
    obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 10000;
    for (const e of obs.entities) {
      if (e.kind === 'island') e.side = 'nw';
      if (e.kind === 'bomber') e.hangar = 'e_9000';
    }
    expect(additions(commander(mode, seat.role, data).think(obs)).some(i => i.item === 'bomber')).toBe(false);
  });
});

it('affords from observed free stock, not bank totals', () => {
  const game = createGame({ seed: 3 });
  const seat = { team: 'nw', role: 'depths' } as const;
  const data = game.matchData(seat);
  const obs = game.observe(seat, 0);
  obs.res.alloy = 100;
  obs.res.energy = 100;
  obs.res.freeAlloy = 40;
  obs.res.freeEnergy = 80;
  obs.res.heldAlloy = 60;
  obs.res.heldEnergy = 20;
  obs.queue = [
    { id: 'q_900', item: 'tank', by: 'surface', byCtl: 'human', plane: 'surface', alloy: 90, energy: 30, heldAlloy: 60, heldEnergy: 20, recovery: false, paid: false, next: true, status: 'waiting', reason: 'producer', progress: 0 },
    { id: 'q_901', item: 'bomber', by: 'sky', byCtl: 'human', plane: 'sky', alloy: 1000, energy: 1000, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: false, status: 'blocked', reason: 'producer', producer: 'e_9000', progress: 0 },
  ];
  const context = new Ctx(obs, data, unpackTerrain(data.terrain, data.rules.map.size));
  expect(context.affordableCost(40, 80, 0)).toBe(true);
  expect(context.affordableCost(41, 0, 0)).toBe(false);
  expect(context.affordableCost(0, 81, 0)).toBe(false);
});

it('rejects a stale guarded free-stock claim after allocation while allowing explicit future requests', () => {
  const game = createGame({ seed: 3 });
  const army = game.sim.armies[0]!;
  army.alloy = game.sim.stats.tank.alloy;
  army.energy = 1000;
  expect(game.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'tank', ifAffordable: true }, { source: 'policy' })).toEqual({ ok: true });
  game.sim.allocateQueue(0);
  expect(game.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'bomber', ifAffordable: true }, { source: 'bot' })).toEqual({ ok: false, code: 'cannot_afford' });
  expect(army.queue).toHaveLength(1);
  expect(game.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'bomber' }, { source: 'owner' })).toEqual({ ok: true });
  expect(army.queue).toHaveLength(2);
});

it('admits simultaneous guarded requests without first-connection backing advantage', () => {
  const requests = [['surface', 'trooper'], ['orbit', 'solar']] as const;
  const allocations = [];
  for (const ordered of [requests, [...requests].reverse()]) {
    const game = createGame({ seed: 3 }), sim = game.sim, bank = sim.armies[0]!;
    bank.alloy = STATS.solar.alloy; bank.energy = 1000;
    for (const [role, item] of ordered)
      expect(game.apply({ team: 'nw', role }, { kind: 'queue_add', item, ifAffordable: true }, { source: 'policy' })).toEqual({ ok: true });
    expect(bank.queue.every(e => e.heldAlloy === 0 && !e.started)).toBe(true);
    sim.allocateQueue(0);
    allocations.push(bank.queue.map(e => [e.item, e.heldAlloy]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(bank.queue.map(e => e.heldAlloy)).toEqual([30, 30]);
    expect(bank.alloy).toBe(STATS.solar.alloy);
  }
  expect(allocations[0]).toEqual(allocations[1]);
});

it('checks guarded admission against backed free stock, whole batches and research prices', () => {
  const game = createGame({ seed: 3 });
  const army = game.sim.armies[0]!;
  const surface = { team: 'nw', role: 'surface' } as const;
  const depths = { team: 'nw', role: 'depths' } as const;
  army.alloy = game.sim.stats.tank.alloy * 2;
  army.energy = 1000;
  expect(game.apply(surface, { kind: 'queue_add', item: 'tank', count: 2 })).toEqual({ ok: true });
  game.sim.updateProduction();
  game.sim.allocateQueue(0);
  expect(army.queue[1]).toMatchObject({ started: false, heldAlloy: game.sim.stats.tank.alloy });
  expect(game.apply(depths, { kind: 'queue_add', item: 'digger', ifAffordable: true })).toEqual({ ok: false, code: 'cannot_afford' });
  army.alloy += game.sim.stats.digger.alloy;
  expect(game.apply(depths, { kind: 'queue_add', item: 'digger', ifAffordable: true })).toEqual({ ok: true });

  const batches = createGame({ seed: 3 }), bank = batches.sim.armies[0]!;
  bank.alloy = batches.sim.stats.interceptor.alloy; bank.energy = 1000;
  expect(batches.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'interceptor', count: 2, ifAffordable: true })).toEqual({ ok: false, code: 'cannot_afford' });
  expect(batches.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'interceptor', ifAffordable: true })).toEqual({ ok: true });
  const upgrade = game.matchData(depths).upgrades.find(u => u.id === 'drill_bits')!;
  const research = createGame({ seed: 3 });
  research.sim.armies[0]!.alloy = upgrade.alloy - 1;
  research.sim.armies[0]!.energy = 1000;
  expect(research.apply(depths, { kind: 'research', upgrade: 'drill_bits', ifAffordable: true })).toEqual({ ok: false, code: 'cannot_afford' });
});

it('protects explicit owner/agent entries on automated seats, and owner adoption of an automatic entry', () => {
  const game = createGame({ seed: 3 });
  const seat = { team: 'nw', role: 'depths' } as const;
  game.setSeatInfo(seat, { controller: 'agent', mandate: { autonomy: 'autonomous', directive: { stance: 'defend' }, whenAbsent: 'policy' } });
  for (const e of game.sim.ents) if (e.side === 0 && e.kind === 'digger') game.sim.damage(e, e.hp, 1);
  game.sim.armies[0]!.alloy = 0;
  game.apply(seat, { kind: 'queue_add', item: 'warden' }, { source: 'owner' });
  game.apply(seat, { kind: 'queue_add', item: 'sapper' }, { source: 'agent' });
  game.apply(seat, { kind: 'queue_add', item: 'warden' }, { source: 'policy' });
  game.apply(seat, { kind: 'queue_add', item: 'digger', index: 0 }, { source: 'policy' });
  let queue = game.observe(seat, 0).queue;
  expect(queue.map(q => q.item)).toEqual(['warden', 'sapper', 'digger', 'warden']);
  expect(queue[0]).toMatchObject({ byCtl: 'human' });
  expect(queue[0]!.automatic).toBeUndefined();
  expect(queue[1]!.automatic).toBeUndefined();
  for (const q of queue.slice(0, 2)) {
    expect(game.apply(seat, { kind: 'queue_cancel', entry: q.id }, { source: 'policy' })).toEqual({ ok: false, code: 'invalid_target' });
    expect(game.apply(seat, { kind: 'queue_move', entry: q.id, index: 0 }, { source: 'bot' })).toEqual({ ok: false, code: 'invalid_target' });
  }
  const warden = queue.find(q => q.item === 'warden' && q.automatic)!;
  expect(game.apply(seat, { kind: 'queue_move', entry: warden.id, index: 0 }, { source: 'owner' })).toEqual({ ok: true });
  expect(game.apply(seat, { kind: 'queue_cancel', entry: warden.id }, { source: 'policy' })).toEqual({ ok: false, code: 'invalid_target' });
  queue = game.observe(seat, 0).queue;
  expect(queue[0]!.id).toBe(warden.id);
  expect(queue[0]!.automatic).toBeUndefined();
});

for (const mode of ['policy', 'standard', 'veteran'] as const) it(`${mode} clears only its impossible automatic plan, not manual plans, funding waits or temporary builder loss`, () => {
  const game = createGame({ seed: 3 });
  const seat = { team: 'nw', role: 'depths' } as const;
  const data = game.matchData(seat), obs = game.observe(seat, 0);
  obs.queue = [
    { id: 'q_900', item: 'sapper', by: 'depths', byCtl: 'agent', automatic: true, plane: 'depths', alloy: 60, energy: 40, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: false, status: 'blocked', reason: 'segment_destroyed', progress: 0 },
    { id: 'q_901', item: 'sapper', by: 'depths', byCtl: 'human', plane: 'depths', alloy: 60, energy: 40, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: false, status: 'blocked', reason: 'segment_destroyed', progress: 0 },
    { id: 'q_902', item: 'geothermal', by: 'depths', byCtl: 'agent', automatic: true, plane: 'depths', alloy: 60, energy: 40, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: false, status: 'blocked', reason: 'no_builder', progress: 0 },
    { id: 'q_903', item: 'warden', by: 'depths', byCtl: 'agent', automatic: true, plane: 'depths', alloy: 10000, energy: 40, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: true, status: 'waiting', reason: 'funds', progress: 0 },
    { id: 'q_904', item: 'trooper', by: 'surface', byCtl: 'bot', automatic: true, plane: 'surface', alloy: 40, energy: 0, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: true, status: 'waiting', reason: 'funds', progress: 0 },
  ];
  obs.res.alloy = obs.res.freeAlloy = 40; obs.res.energy = obs.res.freeEnergy = 1000;
  const driver = commander(mode, seat.role, data);
  for (const tick of [0, 160, 320]) {
    obs.tick = tick;
    const cancels = driver.think(obs).filter(i => i.kind === 'queue_cancel');
    expect(cancels).toEqual([{ kind: 'queue_cancel', entry: 'q_900' }]);
  }
});

for (const mode of ['policy', 'standard'] as const) it(`${mode} restores a lost workforce through a real simultaneous four-role scarce-alloy sequence`, () => {
  // Keep the real controller loop, queue funding, mining and deliveries; no economic/stat overrides.
  const game = createGame({ seed: 3, options: { surface: { postsEnabled: false } } });
  const army = game.sim.armies[0]!;
  for (const e of game.sim.ents) if (e.side === 0 && e.kind === 'digger') game.sim.damage(e, e.hp, 1);
  army.alloy = 0; army.energy = 1000;
  const roles = ['depths', 'surface', 'sky', 'orbit'] as const;
  const drivers = roles.map(role => ({ seat: { team: 'nw', role } as const, driver: commander(mode, role, game.matchData({ team: 'nw', role })) }));
  const source = mode === 'policy' ? 'policy' : 'bot';
  game.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'trooper' }, { source: 'owner' });
  const manual = game.observe({ team: 'nw', role: 'surface' }, 0).queue[0]!.id;
  for (const [role, item] of [['surface', 'tank'], ['sky', 'bomber'], ['orbit', 'lancer']] as const)
    game.apply({ team: 'nw', role }, { kind: 'queue_add', item }, { source });
  const initial = new Set(game.sim.ents.map(e => e.id));
  let firstWorker = -1, restored = -1, resumed = -1, firstLoad = -1, firstDelivery = -1;
  const carried = new Map<number, number>();
  // Recovery gets only its capped share while normal lanes demand funds. Budget the full target from Spire
  // trickle alone, then allow a minute for the recovered crew's mining trip and normal production to finish.
  const target = game.sim.econ.queueRecoveryWorkers;
  const recoveryBudget = toTicks(target * game.sim.stats.digger.alloy / (game.sim.econ.spireAlloyRate * game.sim.econ.queueRecoveryFraction))
    + target * game.sim.stats.digger.build;
  const deadline = recoveryBudget + toTicks(60);
  for (let tick = 0; tick < deadline && (restored < 0 || resumed < 0 || firstDelivery < 0); tick++) {
    if (game.tick % 10 === 0) {
      const decisions = drivers.map(({ seat, driver }) => driver.think(game.observe(seat, Math.max(0, game.tick - 10))));
      game.sim.round(() => drivers.forEach(({ seat }, i) => {
        for (const intent of decisions[i]!) {
          if (intent.kind === 'queue_cancel' || intent.kind === 'queue_move') expect(intent.entry).not.toBe(manual);
          game.apply(seat, intent, { source });
        }
      }));
    }
    game.step();
    expect(army.queue.filter(q => q.item === 'digger')).toHaveLength(army.queue.some(q => q.item === 'digger') ? 1 : 0);
    const workers = game.sim.ents.filter(e => !e.dead && e.side === 0 && e.kind === 'digger').length;
    if (firstWorker < 0 && workers > 0) firstWorker = game.tick;
    // Digging through an ore cell already yields a load, so the first load may come before any `mining` state; and
    // ore caches credit alloyMined to whoever holds them, so a crew delivery is a digger emptying its load.
    const diggers = game.sim.ents.filter(e => !e.dead && e.side === 0 && e.kind === 'digger');
    if (firstLoad < 0 && diggers.some(e => e.carry > 0)) firstLoad = game.tick;
    if (firstDelivery < 0 && diggers.some(e => e.carry === 0 && (carried.get(e.id) ?? 0) > 0)) firstDelivery = game.tick;
    for (const e of diggers) carried.set(e.id, e.carry);
    if (restored < 0 && workers >= game.sim.econ.queueRecoveryWorkers) restored = game.tick;
    if (game.sim.ents.some(e => !initial.has(e.id) && e.side === 0 && ['tank', 'bomber', 'lancer'].includes(e.kind)) && resumed < 0) resumed = game.tick;
  }
  expect(firstWorker).toBeGreaterThan(0);
  expect(restored).toBeGreaterThan(firstWorker);
  expect(resumed).toBeGreaterThan(0);
  // Every ore load and delivery comes from the restored crew (the whole starting workforce was destroyed).
  expect(firstLoad).toBeGreaterThan(firstWorker);
  expect(firstDelivery).toBeGreaterThan(firstLoad);
  expect(army.alloy).toBeGreaterThanOrEqual(0);
}, 20000);
