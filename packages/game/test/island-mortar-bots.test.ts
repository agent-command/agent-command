import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import type { MatchData, Observation } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';

const seat = { team: 'nw', role: 'sky' } as const;
const modes = ['standard', 'veteran', 'policy'] as const;

function fixture(mounted = false) {
  const g = createGame({ seed: 9 });
  const s = g.sim;
  const home = s.armies[0]!.spire.sky;
  const island = s.ents.filter(e => e.kind === 'island')
    .sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y))[0]!;
  s.setSide(island, 0);
  const relay = s.add('relay', 0, 'sky', island.x, island.y);
  relay.link = island.id;
  island.link = relay.id;
  for (let i = 0; i < 5; i++) s.add('interceptor', 0, 'sky', island.x, island.y);
  const target = s.add('shaft', 1, 'surface', island.x + 2, island.y);
  s.add('trooper', 0, 'surface', target.x, target.y + 2);
  const mortar = mounted ? s.add('island_mortar', 0, 'sky', island.x, island.y) : undefined;
  if (mortar) { mortar.link = island.id; island.hardpoint = mortar.id; }
  s.armies[0]!.alloy = 5000;
  s.armies[0]!.energy = 5000;
  s.computeVision();
  const obs = g.observe(seat, 0);
  const data = g.matchData(seat);
  function decide(mode: typeof modes[number]) {
    const bot = mode === 'policy'
      ? runInNewContext(`${STARTER_POLICIES.sky}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] }
      : createBot('nw', 'sky', mode);
    bot.init?.(data);
    return structuredClone(bot.think(obs));
  }
  const id = (e: Ent): string => g.entityId('nw', e.id);
  return { g, s, island, relay, target, mortar, obs, data, decide, id };
}

describe('Island Mortar Sky consumers', () => {
  for (const mode of modes) {
    it(`${mode}: buys one useful secondary mortar without replacing the Relay`, () => {
      const f = fixture();
      expect(f.obs.entities.some(e => e.id === f.id(f.target))).toBe(true);
      const builds = f.decide(mode).filter(i => i.kind === 'queue_add' && i.item === 'island_mortar');
      expect(builds).toEqual([{ kind: 'queue_add', item: 'island_mortar', island: f.id(f.island), ifAffordable: true }]);
      expect(f.g.apply(seat, builds[0]!, { source: mode === 'policy' ? 'policy' : 'bot' })).toEqual({ ok: true });
      expect(f.island.link).toBe(f.relay.id);
      expect(f.g.observe(seat, 0).queue.some(q => q.item === 'island_mortar' && q.island === f.id(f.island))).toBe(true);
    });

    for (const reason of ['hidden', 'distant', 'unguarded', 'occupied', 'contested', 'poor', 'upkeep', 'segment', 'disabled', 'queued'] as const) {
      it(`${mode}: declines a mortar when ${reason}`, () => {
        const f = fixture();
        const island = f.obs.entities.find(e => e.id === f.id(f.island))!;
        const target = f.obs.entities.find(e => e.id === f.id(f.target))!;
        if (reason === 'hidden') f.obs.entities = f.obs.entities.filter(e => e.id !== target.id);
        if (reason === 'distant') { target.x = island.x + f.data.rules.stats.island_mortar.range + 1; target.y = island.y; }
        if (reason === 'unguarded') for (const e of f.obs.entities) if (e.kind === 'interceptor' && e.side === 'nw') { e.x = 1; e.y = 1; }
        if (reason === 'occupied') f.obs.islands.find(i => i.id === island.id)!.hardpoint = { kind: 'gun_platform', side: 'nw' };
        if (reason === 'contested') island.state = 'contested';
        if (reason === 'poor') { f.obs.res.alloy = f.obs.res.freeAlloy = 140; f.obs.res.energy = f.obs.res.freeEnergy = 80; }
        if (reason === 'upkeep') { f.obs.res.energyRate = 0; f.obs.res.upkeep = 3; }
        if (reason === 'segment') f.obs.spire.find(s => s.plane === 'sky')!.hp = 0;
        if (reason === 'disabled') f.data.rules.sky.islandHardpoints = 0;
        if (reason === 'queued') {
          expect(f.g.apply(seat, { kind: 'queue_add', item: 'island_mortar', island: island.id })).toEqual({ ok: true });
          f.obs.queue = f.g.observe(seat, 0).queue;
        }
        expect(f.decide(mode).some(i => i.kind === 'queue_add' && i.item === 'island_mortar')).toBe(false);
      });
    }

    it(`${mode}: orders only visible in-range Surface targets, drifting or lowered`, () => {
      const f = fixture(true);
      const mortar = f.obs.entities.find(e => e.id === f.id(f.mortar!))!;
      const target = f.obs.entities.find(e => e.id === f.id(f.target))!;
      const fire = () => f.decide(mode).filter(i => i.kind === 'attack' && i.units.includes(mortar.id));
      const order = { kind: 'attack', units: [mortar.id], target: target.id };
      expect(fire()).toEqual([order]);
      expect(f.g.apply(seat, order as AgentCommandIntent)).toEqual({ ok: true });
      mortar.elevation = -8;
      expect(fire()).toEqual([order]);
      expect(f.decide(mode).some(i => i.kind === 'queue_add' && i.item === 'island_mortar')).toBe(false);
      target.x = mortar.x + f.data.rules.stats.island_mortar.range + 0.01;
      target.y = mortar.y;
      expect(fire()).toEqual([]);
      target.x = mortar.x + 1;
      target.plane = 'sky';
      expect(fire()).toEqual([]);
      f.obs.entities = f.obs.entities.filter(e => e.id !== target.id);
      expect(fire()).toEqual([]);
    });

    it(`${mode}: attacks a hostile mortar before capturing its island`, () => {
      const f = fixture(true);
      const islandId = f.id(f.island), mortarId = f.id(f.mortar!);
      f.obs.entities = f.obs.entities.filter(e => e.kind !== 'island' || e.id === islandId);
      for (const e of f.obs.entities) {
        if (e.id === islandId || e.id === mortarId || e.id === f.id(f.relay)) e.side = 'se';
      }
      f.obs.islands.find(i => i.id === islandId)!.hardpoint = { kind: 'island_mortar', side: 'se' };
      const out = f.decide(mode);
      expect(out.some(i => i.kind === 'attack' && i.target === mortarId)).toBe(true);
      expect(out.some(i => i.kind === 'capture' && i.island === islandId && i.queue === true)).toBe(true);
    });
  }
});
