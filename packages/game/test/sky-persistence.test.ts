import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { toTicks, type MatchData, type Observation } from '../src/rules/contract.ts';

const seat = { team: 'nw', role: 'sky' } as const;
const modes = ['standard', 'veteran', 'policy'] as const;
function setup(mode: typeof modes[number] = 'standard') {
  const g = createGame({ seed: 9 });
  const s = g.sim;
  const home = s.armies[0]!.spire.sky;
  const islands = s.ents.filter(e => e.kind === 'island').sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y));
  const island = islands[0]!;
  s.setSide(island, 0);
  s.armies[0]!.alloy = 5000;
  s.armies[0]!.energy = 5000;
  const bot = mode === 'policy'
    ? runInNewContext(`${STARTER_POLICIES.sky}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] }
    : createBot('nw', 'sky', mode);
  bot.init?.(g.matchData(seat));
  const air = s.add('interceptor', 0, 'sky', island.x, island.y);
  function decide() { return structuredClone(bot.think(g.observe(seat, 0))); }
  function apply() {
    const intents = decide();
    for (const intent of intents) expect(g.apply(seat, intent, { source: mode === 'policy' ? 'policy' : 'bot' }), JSON.stringify(intent)).toEqual({ ok: true });
    return intents;
  }
  function advance(ticks: number, thinking = true) {
    for (let i = 0; i < ticks; i++) {
      if (thinking && s.tick % BOT_PERIOD === 0) apply();
      g.step();
    }
  }
  return { g, s, islands, island, air, bot, decide, apply, advance };
}

describe('Sky investment persistence', () => {
  for (const mode of modes) {
    it(`${mode}: completes a protected Relay after losing the Sky segment`, () => {
      const f = setup(mode);
      f.s.armies[0]!.spire.sky.hp = 0;
      f.g.step();
      const out = f.apply();
      expect(out).toContainEqual({ kind: 'queue_add', item: 'relay', island: f.g.entityId('nw', f.island.id), ifAffordable: true });
      expect(out.some(i => i.kind === 'queue_add' && ['aerie', 'stormcatcher', 'storm_seeder'].includes(i.item))).toBe(false);
      f.advance(f.s.stats.relay.build + 1, false);
      expect(f.s.alive(f.island.link)).toMatchObject({ kind: 'relay', built: true, side: 0 });
      expect(f.island.side).toBe(0);
      expect(Math.hypot(f.air.x - f.island.x, f.air.y - f.island.y)).toBeLessThanOrEqual(f.s.econ.captureRadius);
    });

    it(`${mode}: does not buy into advancing/contested claims or uncovered sites`, () => {
      const f = setup(mode);
      const island = f.g.entityId('nw', f.island.id);
      for (const state of ['capturing', 'contested'] as const) {
        const obs = f.g.observe(seat, 0);
        obs.entities.find(e => e.id === island)!.state = state;
        expect(f.bot.think(obs).some(i => i.kind === 'queue_add' && i.island === island)).toBe(false);
      }
      f.air.x = 1; f.air.y = 1;
      expect(f.decide().some(i => i.kind === 'queue_add' && i.island === island)).toBe(false);
    });

    it(`${mode}: retains island guards through impacts and immediately assigns replacements`, () => {
      const f = setup(mode);
      const relay = f.s.add('relay', 0, 'sky', f.island.x, f.island.y);
      relay.link = f.island.id; f.island.link = relay.id;
      for (let i = 0; i < 4; i++) f.s.add('interceptor', 0, 'sky', f.island.x + 3 + i, f.island.y);
      const obs = f.g.observe(seat, 0);
      const ownIsland = obs.entities.find(e => e.id === f.g.entityId('nw', f.island.id))!;
      ownIsland.state = 'capturing'; ownIsland.progress = 0.5;
      obs.impacts = [{ id: 'e_9999', side: 'se', x: 30, y: 30, tick: toTicks(8) }];
      const out = f.bot.think(obs);
      const guard = out.find(i => i.kind === 'capture' && i.island === ownIsland.id);
      expect(guard?.kind).toBe('capture');
      if (guard?.kind !== 'capture') throw new Error('missing guard');
      const attack = out.find(i => i.kind === 'attack' && i.target === 'e_9999');
      expect(attack?.kind).toBe('attack');
      if (attack?.kind !== 'attack') throw new Error('missing payload subset');
      expect(attack.units.every(id => !guard.units.includes(id))).toBe(true);
      expect(out.some(i => i.kind === 'macro' && i.action === 'intercept')).toBe(false);
      obs.tick += toTicks(1.5); // standard's decision cadence, still far shorter than the old recapture timer
      obs.entities = obs.entities.filter(e => !guard.units.includes(e.id));
      const replacement = f.bot.think(obs).find(i => i.kind === 'capture' && i.island === ownIsland.id);
      expect(replacement?.kind).toBe('capture');
      if (replacement?.kind === 'capture') expect(replacement.units.every(id => !guard.units.includes(id))).toBe(true);
    });

    it(`${mode}: chooses Aerie repair support before filling a three-island share with Relays`, () => {
      const f = setup(mode);
      const relay = f.s.add('relay', 0, 'sky', f.island.x, f.island.y);
      relay.link = f.island.id; f.island.link = relay.id;
      for (const island of f.islands.slice(1, 3)) {
        f.s.setSide(island, 0);
        f.s.add('interceptor', 0, 'sky', island.x, island.y);
      }
      f.air.hp = f.air.maxHp / 2;
      const obs = f.g.observe(seat, 0);
      obs.res.solarRate = 0;
      const out = f.bot.think(obs);
      expect(out.some(i => i.kind === 'queue_add' && i.item === 'aerie')).toBe(true);
      expect(out.some(i => i.kind === 'queue_add' && i.item === 'relay')).toBe(false);
    });

    it(`${mode}: replaces a dead producer queue through the living Spire and actually completes aircraft`, () => {
      const f = setup(mode);
      const aerie = f.s.add('aerie', 0, 'sky', f.island.x, f.island.y);
      aerie.link = f.island.id; f.island.link = aerie.id;
      const producer = f.g.entityId('nw', aerie.id);
      expect(f.g.apply(seat, { kind: 'queue_add', item: 'interceptor', producer }, { source: mode === 'policy' ? 'policy' : 'bot' })).toEqual({ ok: true });
      f.g.step();
      aerie.hp = 0;
      f.g.step(); f.g.step();
      const stranded = f.g.observe(seat, 0).queue.find(q => q.producer === producer)!;
      expect(stranded).toMatchObject({ status: 'blocked', reason: 'producer' });
      expect(f.apply()).toContainEqual({ kind: 'queue_cancel', entry: stranded.id });
      expect(f.g.observe(seat, 0).queue.some(q => q.id === stranded.id)).toBe(false);
      const before = f.s.armies[0]!.stats.produced;
      f.advance(f.s.stats.interceptor.build + BOT_PERIOD * 3);
      expect(f.s.armies[0]!.stats.produced).toBeGreaterThan(before);
      expect(f.g.observe(seat, 0).queue.some(q => q.producer === producer)).toBe(false);
    });

    it(`${mode}: recovers through another Aerie without a Sky segment`, () => {
      const f = setup(mode);
      const first = f.s.add('aerie', 0, 'sky', f.island.x, f.island.y);
      first.link = f.island.id; f.island.link = first.id;
      const island = f.islands[1]!;
      f.s.setSide(island, 0);
      const backup = f.s.add('aerie', 0, 'sky', island.x, island.y);
      backup.link = island.id; island.link = backup.id;
      expect(f.g.apply(seat, { kind: 'queue_add', item: 'interceptor', producer: f.g.entityId('nw', first.id) }, { source: mode === 'policy' ? 'policy' : 'bot' })).toEqual({ ok: true });
      f.g.step();
      first.hp = 0; f.s.armies[0]!.spire.sky.hp = 0;
      f.g.step(); f.g.step();
      expect(f.apply()).toContainEqual({ kind: 'queue_add', item: 'interceptor', producer: f.g.entityId('nw', backup.id) });
      const before = f.s.armies[0]!.stats.produced;
      f.advance(f.s.stats.interceptor.build + 1, false);
      expect(f.s.armies[0]!.stats.produced).toBeGreaterThan(before);
      expect(f.g.observe(seat, 0).queue.some(q => q.producer === f.g.entityId('nw', first.id))).toBe(false);
    });

    it(`${mode}: leaves an existing unpowered producer queue intact without repurchasing`, () => {
      const f = setup(mode);
      const aerie = f.s.add('aerie', 0, 'sky', f.island.x, f.island.y);
      aerie.link = f.island.id; f.island.link = aerie.id;
      const producer = f.g.entityId('nw', aerie.id);
      expect(f.g.apply(seat, { kind: 'queue_add', item: 'interceptor', producer }, { source: mode === 'policy' ? 'policy' : 'bot' })).toEqual({ ok: true });
      f.g.step();
      const queue = f.g.observe(seat, 0).queue.find(q => q.producer === producer)!;
      f.s.armies[0]!.spire.sky.hp = 0;
      for (const e of f.s.ents) if (e.kind === 'solar' && e.side === 0) e.hp = 0;
      f.s.armies[0]!.energy = 0;
      f.g.step(); f.g.step();
      expect(f.g.observe(seat, 0).queue.find(q => q.id === queue.id)).toMatchObject({ status: 'blocked', reason: 'producer' });
      for (let i = 0; i < 3; i++) {
        expect(f.apply().some(intent => intent.kind === 'queue_cancel' && intent.entry === queue.id)).toBe(false);
        f.advance(BOT_PERIOD, false);
        expect(f.g.observe(seat, 0).queue.some(q => q.id === queue.id)).toBe(true);
      }
      const before = f.s.armies[0]!.stats.produced;
      f.s.armies[0]!.energy = 1000;
      f.advance(f.s.stats.interceptor.build + 1, false);
      expect(f.s.armies[0]!.stats.produced).toBeGreaterThan(before);
      expect(f.g.observe(seat, 0).queue.some(q => q.id === queue.id)).toBe(false);
    });
  }

  it('bounded scripted sim completes, protects and rebuilds infrastructure, then resumes production after Aerie death', () => {
    const f = setup();
    for (const island of f.islands.slice(1, 3)) {
      f.s.setSide(island, 0);
      f.s.add('interceptor', 0, 'sky', island.x, island.y);
    }
    f.advance(toTicks(35));
    const relay = f.s.ents.find(e => e.kind === 'relay' && e.side === 0 && e.built && !e.dead)!;
    const aerie = f.s.ents.find(e => e.kind === 'aerie' && e.side === 0 && e.built && !e.dead)!;
    expect(relay).toBeDefined(); expect(aerie).toBeDefined();
    const island = f.s.alive(relay.link)!;
    const intruder = f.s.add('interceptor', 1, 'sky', island.x, island.y);
    const rock = f.s.add('asteroid', 1, 'orbit', island.x + 6, island.y);
    rock.hp = 1; // A damaged payload isolates the consumer/assignment regression, not interception balance.
    expect(f.s.dropPayload(rock, 1, rock.x, rock.y)).toBe(true);
    f.advance(toTicks(8));
    expect(island.side).toBe(0);
    expect(f.s.alive(relay.id)).toBeDefined();
    expect(rock.dead).toBe(true);
    expect(rock.lastHitCause).toBe('interceptor');
    // Controlled losses establish replacement causally; this is not a natural balance/death-cause measurement.
    const priorRelays = new Set(f.s.ents.filter(e => e.kind === 'relay' && e.side === 0 && !e.dead).map(e => e.id));
    intruder.hp = 0;
    for (const e of f.s.ents) if (priorRelays.has(e.id)) e.hp = 0;
    f.advance(toTicks(20));
    // Replacement may use a safer held island rather than reinvesting on the drifting loss site.
    const rebuilt = f.s.ents.find(e => e.kind === 'relay' && e.side === 0 && e.built && !e.dead && !priorRelays.has(e.id))!;
    expect(rebuilt, JSON.stringify({ queue: f.g.observe(seat, 0).queue, held: f.s.ents.filter(e => e.kind === 'island' && e.side === 0).map(e => ({ id: e.id, link: e.link, state: e.state })) })).toMatchObject({ kind: 'relay', built: true, side: 0 });
    expect(rebuilt.id).not.toBe(relay.id);
    const producer = f.g.entityId('nw', aerie.id);
    expect(f.g.apply(seat, { kind: 'queue_add', item: 'interceptor', producer }, { source: 'bot' })).toEqual({ ok: true });
    f.g.step(); aerie.hp = 0; f.g.step(); f.g.step();
    for (const e of f.s.ents) if (e.kind === 'interceptor' && e.side === 0 && !e.dead && e.id !== f.air.id) e.hp = 0;
    f.g.step();
    const builtBefore = f.s.armies[0]!.stats.produced;
    f.advance(toTicks(20));
    expect(f.s.armies[0]!.stats.produced).toBeGreaterThan(builtBefore);
    expect(f.g.observe(seat, 0).queue.some(q => q.producer === producer)).toBe(false);
    console.log(JSON.stringify({ scenario: 'Sky persistence scripted', seed: 9, ticks: f.s.tick, relay: relay.id, rebuiltRelay: rebuilt.id, lostAerie: aerie.id, aircraftCompletedAfterLoss: f.s.armies[0]!.stats.produced - builtBefore, rulesHash: f.g.matchData(seat).rulesHash }));
  });
});
