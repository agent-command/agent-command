import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { TOPICS } from '../src/agent/docs/index.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import type { Entity, MatchData, Observation, Plane } from '../src/rules/contract.ts';

const seat = { team: 'nw', role: 'sky' } as const;
const modes = ['standard', 'veteran', 'policy'] as const;
type Mode = typeof modes[number];

function controller(mode: Mode, role: Plane, data: MatchData) {
  const bot = mode === 'policy'
    ? runInNewContext(`${STARTER_POLICIES[role]}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] }
    : createBot('nw', role, mode);
  bot.init?.(data);
  return { think: (obs: Observation): AgentCommandIntent[] => structuredClone(bot.think(obs)) };
}

function fixture() {
  const g = createGame({ seed: 91, options: { terrain: 'open', map: { params: { homeLodes: 0, contestedZones: [] } } } });
  const s = g.sim;
  const island = s.ents.find(e => e.kind === 'island')!;
  island.x = 14.5; island.y = 14.5;
  island.oreCapacity = island.oreRemaining = 240;
  island.oreBuffer = 0;
  s.setSide(island, 0);
  const relay = s.add('relay', 0, 'sky', island.x, island.y);
  relay.link = island.id; island.link = relay.id;
  for (let i = 0; i < 6; i++) s.add('interceptor', 0, 'sky', island.x, island.y);
  s.armies[0]!.alloy = 5000; s.armies[0]!.energy = 5000;
  s.computeVision();
  const data = g.matchData(seat);
  const obs = g.observe(seat, 0);
  obs.res.energyRate = 20;
  obs.weather.storms = []; obs.weather.forecast = []; obs.weather.seeded = []; obs.weather.seedWarnings = [];
  obs.research.available = [];
  const observed = obs.entities.find(e => e.id === g.entityId('nw', island.id))!;
  function decide(mode: Mode) { return controller(mode, 'sky', data).think(obs); }
  function mount() {
    const extractor = s.add('ore_extractor', 0, 'sky', island.x, island.y);
    extractor.link = island.id; island.hardpoint = extractor.id;
    s.computeVision();
    const e = g.observe(seat, 0).entities.find(e => e.id === g.entityId('nw', extractor.id))!;
    obs.entities.push(e);
    obs.islands.find(i => i.id === observed.id)!.hardpoint = { kind: 'ore_extractor', side: 'nw' };
    return { extractor, e };
  }
  function service() {
    const unit = s.add('trooper', 0, 'surface', island.x + 0.75, island.y);
    s.computeVision();
    const current = g.observe(seat, 0);
    obs.entities.push(current.entities.find(e => e.id === g.entityId('nw', unit.id))!);
    obs.surfaceVision = current.surfaceVision;
    island.oreBuffer = observed.oreBuffer = 40;
    return obs.entities.find(e => e.id === g.entityId('nw', unit.id))!;
  }
  return { g, s, data, obs, island, observed, relay, decide, mount, service };
}

for (const mode of modes) describe(`${mode}: finite island ore automation`, () => {
  it('funds a guarded powered secondary extractor without replacing the main slot or its guards', () => {
    const f = fixture();
    const out = f.decide(mode);
    const build = out.find(i => i.kind === 'queue_add' && i.item === 'ore_extractor');
    expect(build).toEqual({ kind: 'queue_add', item: 'ore_extractor', island: f.observed.id, ifAffordable: true });
    expect(f.g.apply(seat, build!)).toEqual({ ok: true });
    expect(f.island.link).toBe(f.relay.id);
    expect(f.g.observe(seat, 0).queue.some(q => q.item === 'ore_extractor' && q.island === f.observed.id)).toBe(true);
    const guards = out.filter(i => i.kind === 'capture').filter(i => i.island === f.observed.id).flatMap(i => i.units);
    expect(guards.length).toBeGreaterThan(0);
    expect(out.some(i => (i.kind === 'move' || i.kind === 'attack' || i.kind === 'ascend') && i.units.some(id => guards.includes(id)))).toBe(false);
  });

  it('can fund the main Relay and independent extractor together on a guarded bare ore island', () => {
    const f = fixture();
    delete f.observed.link;
    f.obs.entities = f.obs.entities.filter(e => e.id !== f.g.entityId('nw', f.relay.id));
    const orders = f.decide(mode).filter(i => i.kind === 'queue_add').filter(i => i.island === f.observed.id);
    expect(orders.some(i => i.item === 'relay')).toBe(true);
    expect(orders.some(i => i.item === 'ore_extractor')).toBe(true);
  });

  for (const reason of ['gun_platform', 'island_mortar', 'ore_extractor', 'unguarded', 'unpowered', 'poor', 'segment', 'screen', 'unknown', 'depleted', 'contested', 'enemy', 'ground-fire', 'queued'] as const) {
    it(`refuses new extraction when ${reason}`, () => {
      const f = fixture();
      if (reason === 'gun_platform' || reason === 'island_mortar' || reason === 'ore_extractor')
        f.obs.islands.find(i => i.id === f.observed.id)!.hardpoint = { kind: reason, side: 'nw' };
      if (reason === 'unguarded') for (const e of f.obs.entities) if (e.kind === 'interceptor') { e.x = 1.5; e.y = 1.5; }
      if (reason === 'unpowered') { f.obs.res.energyRate = 0; f.obs.res.upkeep = 3; }
      if (reason === 'poor') { f.obs.res.alloy = f.obs.res.freeAlloy = 80; f.obs.res.energy = f.obs.res.freeEnergy = 40; }
      if (reason === 'segment') f.obs.spire.find(s => s.plane === 'sky')!.hp = 0;
      if (reason === 'screen') f.obs.entities = f.obs.entities.filter(e => e.kind !== 'interceptor');
      if (reason === 'unknown') delete f.observed.oreRemaining;
      if (reason === 'depleted') f.observed.oreRemaining = 0;
      if (reason === 'contested') f.observed.state = 'contested';
      if (reason === 'enemy') f.obs.entities.push({ ...f.obs.entities.find(e => e.kind === 'interceptor')!,
        id: 'e_99999', side: 'se', x: f.observed.x, y: f.observed.y });
      if (reason === 'ground-fire') f.obs.entities.push({ ...f.observed, id: 'e_99998', kind: 'flak', plane: 'surface', side: 'se' });
      if (reason === 'queued') {
        expect(f.g.apply(seat, { kind: 'queue_add', item: 'island_mortar', island: f.observed.id })).toEqual({ ok: true });
        f.obs.queue = f.g.observe(seat, 0).queue;
      }
      expect(f.decide(mode).some(i => i.kind === 'queue_add' && i.item === 'ore_extractor')).toBe(false);
    });
  }

  it('uses observed local air danger, not hidden or distant enemies, for extraction investment', () => {
    const f = fixture();
    const enemy = f.s.add('interceptor', 1, 'sky', 35.5, 35.5);
    const refreshEntities = () => {
      f.s.computeVision();
      f.obs.entities = f.g.observe(seat, 0).entities;
    };
    const invests = () => f.decide(mode).some(i => i.kind === 'queue_add' && i.item === 'ore_extractor');
    refreshEntities();
    expect(f.s.aliasOf(0, enemy.id)).toBe(0); // never seen, so never named
    expect(invests()).toBe(true);

    f.s.add('interceptor', 0, 'sky', enemy.x, enemy.y);
    refreshEntities();
    const enemyId = f.g.entityId('nw', enemy.id);
    expect(f.obs.entities.some(e => e.id === enemyId)).toBe(true);
    expect(invests()).toBe(true);

    enemy.x = f.island.x; enemy.y = f.island.y;
    refreshEntities();
    expect(f.obs.entities.find(e => e.id === enemyId)).toMatchObject({ x: f.island.x, y: f.island.y });
    expect(invests()).toBe(false);
  });

  it('retires only its automatic permanently depleted extractor reservation', () => {
    const f = fixture();
    expect(f.g.apply(seat, { kind: 'queue_add', item: 'ore_extractor', island: f.observed.id },
      { source: mode === 'policy' ? 'policy' : 'bot' })).toEqual({ ok: true });
    f.island.oreRemaining = f.observed.oreRemaining = 0;
    f.g.step();
    f.obs.queue = f.g.observe(seat, 0).queue;
    const queued = f.obs.queue.find(q => q.item === 'ore_extractor')!;
    expect(queued).toMatchObject({ automatic: true, status: 'blocked', reason: 'blocked' });
    const cancel = { kind: 'queue_cancel', entry: queued.id };
    expect(f.decide(mode)).toContainEqual(cancel);
    delete f.observed.oreRemaining;
    expect(f.decide(mode)).not.toContainEqual(cancel);
    f.observed.oreRemaining = 0;
    f.observed.side = 'se';
    expect(f.decide(mode)).not.toContainEqual(cancel);
    f.observed.side = 'nw';
    queued.automatic = false;
    expect(f.decide(mode)).not.toContainEqual(cancel);
    queued.automatic = true;
    queued.by = 'surface';
    expect(f.decide(mode)).not.toContainEqual(cancel);
    queued.by = 'sky';
    queued.status = 'waiting';
    expect(f.decide(mode)).not.toContainEqual(cancel);
    queued.status = 'blocked';
    const order = f.decide(mode).find(i => i.kind === 'queue_cancel' && i.entry === queued.id)!;
    expect(f.g.apply(seat, order)).toEqual({ ok: true });
    expect(f.g.observe(seat, 0).queue.some(q => q.id === queued.id)).toBe(false);
  });

  it('prefers a nearby useful ore capture, but not a depleted deposit or an armed threat', () => {
    const f = fixture();
    const home = f.data.armies.find(a => a.id === 'nw')!.spireAt;
    const plain: Entity = { ...f.observed, id: 'e_90001', side: 'neutral', x: home.x + 10, y: home.y, oreCapacity: 0, oreRemaining: 0 };
    const ore: Entity = { ...f.observed, side: 'neutral', x: home.x + 11, y: home.y, oreCapacity: 240, oreRemaining: 240 };
    delete plain.link; delete ore.link;
    f.obs.entities = f.obs.entities.filter(e => e.kind !== 'island' && e.kind !== 'relay');
    f.obs.entities.push(plain, ore);
    expect(f.decide(mode).some(i => i.kind === 'capture' && i.island === ore.id)).toBe(true);
    ore.oreRemaining = 0;
    expect(f.decide(mode).some(i => i.kind === 'capture' && i.island === plain.id)).toBe(true);
    delete ore.oreRemaining;
    expect(f.decide(mode).some(i => i.kind === 'capture' && i.island === ore.id)).toBe(true);
    f.obs.entities.push({ ...f.obs.entities.find(e => e.kind === 'interceptor')!, id: 'e_90002', side: 'se', x: ore.x, y: ore.y });
    expect(f.decide(mode).some(i => i.kind === 'capture' && i.island === plain.id)).toBe(true);
  });

  it('captures through an unarmed hostile extractor instead of treating it as a capture-blocking weapon', () => {
    const f = fixture();
    const { e } = f.mount();
    f.observed.side = e.side = 'se';
    f.obs.entities = f.obs.entities.filter(entity => entity.kind !== 'island' || entity.id === f.observed.id);
    const out = f.decide(mode);
    expect(out.some(i => i.kind === 'capture' && i.island === f.observed.id && !i.queue)).toBe(true);
    expect(out.some(i => i.kind === 'attack' && i.target === e.id)).toBe(false);
  });

  it('drops serviced cargo by island ID without an extractor and without assigning ground orders', () => {
    const f = fixture();
    const hand = f.service();
    f.obs.mandate.limits = { asteroidDrops: false, collapses: false };
    const out = f.decide(mode);
    const drop = out.find(i => i.kind === 'drop_ore');
    expect(drop).toEqual({ kind: 'drop_ore', island: f.observed.id });
    expect(out.some(i => (i.kind === 'move' || i.kind === 'attack') && i.units.includes(hand.id))).toBe(false);
    const alloy = f.s.armies[0]!.alloy;
    expect(f.g.apply(seat, drop!)).toEqual({ ok: true });
    expect(f.s.armies[0]!.alloy).toBe(alloy);
    expect(f.island.oreBuffer).toBe(0);
    expect(f.s.oreCaches).toHaveLength(1);
    expect(f.s.oreCaches[0]).toMatchObject({ alloy: 40, belowAlloy: 0, placed: true });
    expect(f.s.oreCaches[0]!.id).not.toBe(f.island.id);
    expect(Math.hypot(hand.x - f.s.oreCaches[0]!.x, hand.y - f.s.oreCaches[0]!.y)).toBeLessThan(f.data.rules.orbit.oreCacheRadius);
  });

  for (const reason of ['no-service', 'distant', 'enemy', 'unknown-cell', 'unknown-buffer', 'hole', 'structure', 'scorch', 'foreign'] as const) {
    it(`retains cargo when the drop has ${reason}`, () => {
      const f = fixture();
      const hand = f.service();
      if (reason === 'no-service') f.obs.entities = f.obs.entities.filter(e => e.id !== hand.id);
      if (reason === 'distant') hand.x += f.data.rules.orbit.oreCacheRadius;
      if (reason === 'enemy') f.obs.entities.push({ ...hand, id: 'e_99001', side: 'se' });
      if (reason === 'unknown-cell') f.obs.surfaceVision!.fill(0);
      if (reason === 'unknown-buffer') delete f.observed.oreBuffer;
      if (reason === 'hole') f.obs.holes.push({ x: Math.floor(f.island.x), y: Math.floor(f.island.y), kind: 'crater' });
      if (reason === 'structure') f.obs.entities.push({ ...hand, id: 'e_99002', kind: 'headframe', x: f.observed.x, y: f.observed.y });
      if (reason === 'scorch') f.obs.scorches.push({ x: f.island.x, y: f.island.y, radius: 3, until: f.obs.tick + 100 });
      if (reason === 'foreign') f.observed.side = 'se';
      expect(f.decide(mode).some(i => i.kind === 'drop_ore')).toBe(false);
    });
  }

  it('drops cargo and dismantles independently when a depleted extractor has no power', () => {
    const f = fixture();
    const { e } = f.mount();
    f.service();
    f.observed.oreRemaining = f.island.oreRemaining = 0;
    e.extractorPowered = false;
    const out = f.decide(mode);
    expect(out).toContainEqual({ kind: 'drop_ore', island: f.observed.id });
    expect(out).toContainEqual({ kind: 'dismantle', structure: e.id });
    for (const order of out.filter(i => i.kind === 'drop_ore' || i.kind === 'dismantle'))
      expect(f.g.apply(seat, order)).toEqual({ ok: true });
    expect(f.island.oreBuffer).toBe(0);
    expect(f.island.hardpoint).toBe(0);
    expect(f.s.oreCaches[0]!.alloy).toBe(40);
  });

  it('dismantles a depleted own extractor without refund, preserves unsafe cargo and drops it later', () => {
    const f = fixture();
    const { extractor } = f.mount();
    f.observed.oreRemaining = f.island.oreRemaining = 0;
    f.observed.oreBuffer = f.island.oreBuffer = 40;
    const out = f.decide(mode);
    const dismantle = out.find(i => i.kind === 'dismantle');
    expect(dismantle).toEqual({ kind: 'dismantle', structure: f.g.entityId('nw', extractor.id) });
    expect(out.some(i => i.kind === 'drop_ore')).toBe(false);
    const alloy = f.s.armies[0]!.alloy;
    expect(f.g.apply(seat, dismantle!)).toEqual({ ok: true });
    expect(f.s.armies[0]!.alloy).toBe(alloy);
    expect(f.island.oreBuffer).toBe(40);
    expect(f.island.link).toBe(f.relay.id);
    f.obs.entities = f.obs.entities.filter(e => e.id !== f.g.entityId('nw', extractor.id));
    delete f.obs.islands.find(i => i.id === f.observed.id)!.hardpoint;
    f.service();
    expect(f.decide(mode)).toContainEqual({ kind: 'drop_ore', island: f.observed.id });
  });

  it('does not dismantle unknown, live, foreign or unfinished extraction', () => {
    for (const reason of ['unknown', 'live', 'foreign', 'unfinished'] as const) {
      const f = fixture();
      const { e } = f.mount();
      f.observed.oreRemaining = 0;
      if (reason === 'unknown') delete f.observed.oreRemaining;
      if (reason === 'live') f.observed.oreRemaining = 1;
      if (reason === 'foreign') e.side = 'se';
      if (reason === 'unfinished') e.state = 'constructing';
      expect(f.decide(mode).some(i => i.kind === 'dismantle')).toBe(false);
    }
  });

  it('feeds the existing Surface collector assignment and ordinary contested/cache-removal lifecycle', () => {
    const f = fixture();
    f.service();
    const drop = f.decide(mode).find(i => i.kind === 'drop_ore')!;
    expect(f.g.apply(seat, drop)).toEqual({ ok: true });
    const cache = f.s.oreCaches[0]!;
    // Service can leave between decisions. The unchanged Surface policy assigns a normal cache detachment.
    for (const e of f.s.ents) if (e.side === 0 && e.plane === 'surface' && e.unit) { e.x = 10.5; e.y = 14.5; }
    for (let n = 0; n < 6; n++) f.s.add('trooper', 0, 'surface', 10.5 + n / 10, 14.5);
    f.s.computeVision();
    const surfaceSeat = { team: 'nw', role: 'surface' } as const;
    const obs = f.g.observe(surfaceSeat, 0);
    obs.lodes = []; obs.research.available = []; obs.scorches = []; obs.impacts = [];
    const data = f.g.matchData(surfaceSeat);
    data.posts = [];
    obs.entities = obs.entities.filter(e => e.kind !== 'post');
    const bot = controller(mode, 'surface', data);
    const orders = bot.think(obs);
    const collection = orders.filter(i => i.kind === 'move').filter(i => i.x === cache.x && i.y === cache.y);
    expect(collection).toHaveLength(1);
    const collectorIds = collection.flatMap(i => i.units);
    expect(collectorIds).toHaveLength(1);
    expect(orders.some(i => (i.kind === 'move' && (i.x !== cache.x || i.y !== cache.y) || i.kind === 'attack')
      && i.units.some(id => collectorIds.includes(id)))).toBe(false);
    for (const order of collection) expect(f.g.apply(surfaceSeat, order)).toEqual({ ok: true });
    const hand = f.s.byId.get(f.s.aliasTarget(0, Number(collectorIds[0]!.slice(2))))!;
    hand.x = cache.x; hand.y = cache.y;
    const enemy = f.s.add('trooper', 1, 'surface', cache.x, cache.y);
    for (let n = 0; n < f.s.econ.oreCacheTicks; n++) f.s.updateRockGround();
    expect(cache.alloy).toBe(40);
    expect(cache.surfaceTicks).toBe(0);
    enemy.x = 40; enemy.y = 40;
    const alloy = f.s.armies[0]!.alloy;
    for (let n = 0; n < f.s.econ.oreCacheTicks * 2; n++) f.s.updateRockGround();
    expect(f.s.armies[0]!.alloy - alloy).toBe(40);
    expect(f.s.oreCaches).toHaveLength(0);
    const after = f.g.observe(surfaceSeat, 0);
    after.tick = obs.tick + 100;
    after.lodes = []; after.research.available = [];
    expect(bot.think(after).some(i => i.kind === 'move' && i.x === cache.x && i.y === cache.y)).toBe(false);
  });
});

it('registers a bounded focused ore briefing', () => {
  expect(TOPICS['sky/ore']!.text.length).toBeLessThan(8000);
  expect(TOPICS['sky/ore']!.summary.length).toBeLessThanOrEqual(160);
});
