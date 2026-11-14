import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { MAP_SIZES, STATS, UPGRADES, matchDataSchema, type Entity, type MatchData, type MatchOptions, type Observation, type Plane, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { TIERS } from '../src/bots/tuning.ts';

type Mode = 'standard' | 'veteran' | 'policy';
function fixture(team: ArmyId = 'nw', role: Plane = 'orbit', options: MatchOptions = {}) {
  const g = createGame({ seed: 47, options });
  const seat = { team, role };
  const obs = g.observe(seat, 0);
  const data = g.matchData(seat);
  const size = data.rules.map.size;
  obs.entities = obs.entities.filter(e => e.kind === 'island');
  for (const e of obs.entities) e.side = team;
  obs.queue = [];
  obs.tick = 100;
  obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 10000;
  obs.research = { available: role === 'sky' ? ['ascent_thrusters'] : ['aegis_projectors', 'night_cloak'], inProgress: [], completed: [], seen: [] };
  let seq = 100;
  const add = (kind: UnitKind, count = 1, own = true) => {
    for (let i = 0; i < count; i++) {
      const x = own ? 12 + i * 0.8 : 30 + i * 0.8, y = 14;
      const side = own ? team : team === 'nw' ? 'se' : 'nw';
      obs.entities.push({ id: `e_${seq++}`, kind, side, plane: STATS[kind].plane,
        x: team === 'nw' ? x : size - x, y: team === 'nw' ? y : size - y,
        hp: STATS[kind].hp, maxHp: STATS[kind].hp, state: 'idle',
        ...(STATS[kind].shield === undefined ? {} : { shield: STATS[kind].shield, maxShield: STATS[kind].shield }),
      } as Entity);
    }
  };
  // Blue's Surface army past the opening (tier.armyFirst tanks), so a veteran seat (and the starter built from it) no
  // longer holds research and other planes back for it (PlaneBot.armyFirst): these are mid-game states.
  add('tank', TIERS.veteran.armyFirst);
  return { obs, data, add };
}
function decide(mode: Mode, obs: Observation, data: MatchData): AgentCommandIntent[] {
  if (mode === 'policy') return structuredClone((runInNewContext(`${STARTER_POLICIES[obs.role]}\ninit(bootstrap);\nthink;`, { bootstrap: data, log() {} }) as (obs: Observation) => AgentCommandIntent[])(obs));
  const bot = createBot(obs.army, obs.role, mode);
  bot.init?.(data);
  return bot.think(obs);
}
const research = (out: AgentCommandIntent[]) => out.filter(i => i.kind === 'research');

it('bootstraps every registry beneficiary and rule-priced upgrade without hard-coded upgrade/unit pairs', () => {
  const g = createGame({ seed: 47, options: { research: { aegisProjectorsAlloy: 321, aegisProjectorsEnergy: 123 } } });
  const data = g.matchData({ team: 'nw', role: 'orbit' });
  expect(validate(matchDataSchema, data).ok).toBe(true);
  for (const upgrade of Object.values(UPGRADES)) {
    const units = [...new Set(upgrade.effects.flatMap(e => e.kind === 'grant_ability' || e.kind === 'grant_capability' ? e.units : []))];
    expect(data.upgrades.find(row => row.id === upgrade.id)?.units).toEqual(units);
  }
  expect(data.upgrades.find(row => row.id === 'aegis_projectors')).toMatchObject({ alloy: 321, energy: 123, units: ['bastion'] });
});

for (const mode of ['standard', 'veteran', 'policy'] as const) describe(`research composition gate: ${mode}`, () => {
  for (const size of MAP_SIZES) it.each(['orbit', 'sky'] as const)(`never researches with zero beneficiaries in either point-mirrored %s seat on size ${size}`, role => {
    const decisions = [];
    for (const team of ['nw', 'se'] as const) {
      const f = fixture(team, role, { map: { params: { size } } });
      if (role === 'orbit') f.add('lancer', 2, false);
      const out = decide(mode, f.obs, f.data);
      expect(research(out)).toEqual([]);
      decisions.push(out.filter(i => i.kind === 'queue_add').map(i => i.item));
    }
    expect(decisions[0]).toEqual(decisions[1]);
  });

  it('can fund Ascent from its beneficiary screen before island control or perpetual replacement drains the economy', () => {
    const f = fixture('nw', 'sky'); f.add('interceptor', 2);
    for (const e of f.obs.entities) if (e.kind === 'island') e.side = 'neutral';
    f.obs.res.alloy = f.obs.res.freeAlloy = 400; f.obs.res.energy = f.obs.res.freeEnergy = 250;
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'ascent_thrusters', ifAffordable: true });
  });

  it('builds the Bastion counter-composition before buying Aegis', () => {
    const f = fixture(); f.add('lancer', 2, false); f.add('solar');
    const out = decide(mode, f.obs, f.data);
    expect(out).toContainEqual({ kind: 'queue_add', item: 'bastion' });
    expect(research(out)).toEqual([]);
    f.add('bastion', 2);
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'aegis_projectors', ifAffordable: true });
  });

  it('counts current-decision production toward the minimum and reserves the next desired unit', () => {
    const f = fixture(); f.add('lancer', 2, false); f.add('bastion'); f.add('solar');
    const out = decide(mode, f.obs, f.data);
    expect(out).toContainEqual({ kind: 'queue_add', item: 'bastion' });
    expect(research(out)).toContainEqual({ kind: 'research', upgrade: 'aegis_projectors', ifAffordable: true });
    f.obs.res.alloy = f.obs.res.freeAlloy = f.obs.res.energy = f.obs.res.freeEnergy = 350;
    expect(research(decide(mode, f.obs, f.data))).toEqual([]);
    f.obs.res.alloy = f.obs.res.freeAlloy = f.obs.res.energy = f.obs.res.freeEnergy = 500;
    // The next unit is funded, not the entire eventual counter-fleet wishlist.
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'aegis_projectors', ifAffordable: true });
  });

  it('waits for three Skiffs rather than buying cloak for an empty or one-ship raid', () => {
    const f = fixture();
    expect(research(decide(mode, f.obs, f.data))).toEqual([]);
    f.add('skiff');
    expect(research(decide(mode, f.obs, f.data))).toEqual([]);
    f.add('skiff', 2);
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'night_cloak', ifAffordable: true });
  });

  it('reads beneficiary changes from the registry catalog instead of branching on upgrade IDs', () => {
    const f = fixture(); f.add('lancer', 2, false); f.add('bastion', 2);
    f.data.upgrades.find(row => row.id === 'aegis_projectors')!.units = ['tug'];
    expect(research(decide(mode, f.obs, f.data))).toEqual([]);
    f.add('tug', 2);
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'aegis_projectors', ifAffordable: true });
  });

  it('respects resolved research costs and actual backing rather than unpaid wishlists', () => {
    const f = fixture('nw', 'orbit', { research: { nightCloakAlloy: 2000, nightCloakEnergy: 2000 } }); f.add('skiff', 3);
    f.obs.res.alloy = f.obs.res.freeAlloy = f.obs.res.energy = f.obs.res.freeEnergy = 1000;
    expect(research(decide(mode, f.obs, f.data))).toEqual([]);
    f.obs.res.alloy = f.obs.res.freeAlloy = f.obs.res.energy = f.obs.res.freeEnergy = 10000;
    f.obs.queue.push({ id: 'q_1', item: 'tank', plane: 'surface', by: 'surface', byCtl: 'bot', alloy: 10000, energy: 10000, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: true, status: 'waiting', progress: 0 });
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'night_cloak', ifAffordable: true });
    f.obs.queue[0]!.heldAlloy = f.obs.queue[0]!.heldEnergy = 10000;
    f.obs.res.heldAlloy = f.obs.res.heldEnergy = 10000;
    f.obs.res.freeAlloy = f.obs.res.freeEnergy = 0;
    expect(research(decide(mode, f.obs, f.data))).toEqual([]);
  });

  it('uses the independent research slot beside a full production buffer, within the real queue limits', () => {
    const f = fixture(); f.add('bastion', 2); f.add('lancer', 2, false);
    f.obs.queue.push(
      { id: 'q_1', item: 'lancer', plane: 'orbit', by: 'orbit', byCtl: 'bot', alloy: f.data.rules.stats.lancer.alloy, energy: f.data.rules.stats.lancer.energy, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: true, next: false, status: 'building', progress: 0.5 },
      { id: 'q_2', item: 'skiff', plane: 'orbit', by: 'orbit', byCtl: 'bot', alloy: f.data.rules.stats.skiff.alloy, energy: f.data.rules.stats.skiff.energy, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: true, status: 'waiting', progress: 0 },
    );
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'aegis_projectors', ifAffordable: true });
    const full = structuredClone(f.data);
    full.rules.queue.seatMax = 2;
    expect(research(decide(mode, f.obs, full))).toEqual([]);
    f.obs.research.inProgress = ['night_cloak'];
    expect(research(decide(mode, f.obs, f.data))).toEqual([]);
  });

  it('includes queued beneficiary units without counting already-funded units twice', () => {
    const f = fixture(); f.add('lancer', 2, false); f.add('bastion'); f.add('lancer', 20); f.add('skiff', 10);
    f.obs.queue.push({ id: 'q_1', item: 'bastion', plane: 'orbit', by: 'orbit', byCtl: 'bot', alloy: 140, energy: 80, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: true, next: false, status: 'building', progress: 0.5 });
    expect(research(decide(mode, f.obs, f.data))).toContainEqual({ kind: 'research', upgrade: 'aegis_projectors', ifAffordable: true });
  });
});
