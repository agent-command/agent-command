import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { TIERS } from '../src/bots/tuning.ts';
import { ECON, openWindow, STATS, TICK_RATE, toTicks, type DerelictGeometry, type Entity, type MatchData, type Observation, type UnitKind } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { armyIdOfSlot, rotX, rotY } from '../src/util/teams.ts';
import { orbitAsymmetry } from './mirror.ts';
import { periodOf, STARTER_POLICIES, starterScript } from './starter-policies.ts';

const ship = (id: number, kind: UnitKind, side: 'nw' | 'se', x = 20, y = 20): Entity => ({
  id: `e_${id}`, kind, side, plane: 'orbit', x, y,
  hp: STATS[kind].hp, maxHp: STATS[kind].hp, state: 'idle',
  ...(STATS[kind].shield !== undefined ? { shield: STATS[kind].shield, maxShield: STATS[kind].shield } : {}),
});
// Fleet tactics are measured in open space; the derelict tests use the ruin (it spans most of the S48 centre).
const ruin = createGame({ seed: 3 }).matchData({ team: 'nw', role: 'orbit' });
const matchData = structuredClone(ruin);
delete matchData.derelict;
const fixture = (): Observation => {
  const obs = createGame({ seed: 3 }).observe({ team: 'nw', role: 'orbit' }, 0);
  obs.entities = [];
  obs.queue = [];
  obs.res.alloy = obs.res.freeAlloy = 2000;
  obs.res.energy = obs.res.freeEnergy = 2000;
  return obs;
};
/** One decision of a fresh standard or veteran bot, or of a fresh Orbit starter (`source`: built with other knobs). */
function decide(mode: 'standard' | 'veteran' | 'policy', obs: Observation, data: MatchData = matchData, source = STARTER_POLICIES.orbit): AgentCommandIntent[] {
  if (mode === 'policy') {
    return structuredClone((runInNewContext(`${source}\ninit(bootstrap);\nthink;`, { bootstrap: data, log() {} }) as (obs: Observation) => AgentCommandIntent[])(obs));
  }
  const bot = createBot(obs.army, 'orbit', mode);
  bot.init?.(data);
  return bot.think(obs);
}

for (const mode of ['standard', 'veteran', 'policy'] as const) describe(`Orbit fleet tactics: ${mode}`, () => {
  it.each(['metal', 'ice'] as const)('explicitly mines visible %s under a no-drops mandate', (resourceType) => {
    const obs = fixture();
    obs.mandate.limits = { ...obs.mandate.limits, asteroidDrops: false };
    obs.entities = [ship(1, 'tug', 'nw', 12, 12), {
      id: 'e_2', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 13, y: 12,
      hp: 300, maxHp: 300, state: 'drifting', rockSize: 'medium',
      resourceType, volatile: false, resourceRemaining: 120,
    }];
    expect(decide(mode, obs)).toContainEqual({ kind: 'mine_asteroid', units: ['e_1'], asteroid: 'e_2' });
  });

  it.each(['moving', 'grappling', 'mining', 'returning'] as const)('does not overwrite an ongoing %s mining assignment even without a visible target', (state) => {
    const obs = fixture();
    obs.entities = [{ ...ship(1, 'tug', 'nw'), state, miningAssigned: true, cargoAlloy: 0, cargoEnergy: 0 }];
    expect(decide(mode, obs).some((i) => 'units' in i && i.units.includes('e_1'))).toBe(false);
  });

  it('does not acquire unseen resource fields or slag under a no-drops mandate', () => {
    const obs = fixture();
    obs.mandate.limits = { ...obs.mandate.limits, asteroidDrops: false };
    obs.entities = [ship(1, 'tug', 'nw'), {
      id: 'e_2', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 21, y: 20,
      hp: 300, maxHp: 300, state: 'drifting', rockSize: 'medium',
    }];
    expect(decide(mode, obs).some((i) => i.kind === 'mine_asteroid' || i.kind === 'grapple')).toBe(false);
    Object.assign(obs.entities[1]!, { resourceType: 'slag', volatile: false, resourceRemaining: 0 });
    expect(decide(mode, obs).some((i) => i.kind === 'mine_asteroid' || i.kind === 'grapple')).toBe(false);
  });

  it('retains slag towing when drops are allowed', () => {
    const obs = fixture();
    obs.entities = [ship(1, 'tug', 'nw', 12, 12), {
      id: 'e_2', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 13, y: 12,
      hp: 300, maxHp: 300, state: 'drifting', rockSize: 'medium',
      resourceType: 'slag', volatile: false, resourceRemaining: 0,
    }];
    expect(decide(mode, obs)).toContainEqual({ kind: 'grapple', units: ['e_1'], asteroid: 'e_2' });
  });

  it('returns retained mining cargo instead of assigning new work', () => {
    const obs = fixture();
    obs.entities = [{ ...ship(1, 'tug', 'nw', 20, 20), cargoAlloy: 20, cargoEnergy: 0 }];
    const orders = decide(mode, obs).filter((i) => 'units' in i && i.units.includes('e_1'));
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ kind: 'move', units: ['e_1'] });
  });

  it('chooses Aegis against scouted Lancers and cloak without Bastion escorts', () => {
    const obs = fixture();
    obs.research.available = ['aegis_projectors', 'night_cloak'];
    obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 10000;
    obs.entities.push(ship(1, 'bastion', 'nw'), ship(2, 'bastion', 'nw'), ship(5, 'skiff', 'nw'),
      ship(6, 'skiff', 'nw'), ship(7, 'skiff', 'nw'), ship(3, 'lancer', 'se', 25), ship(4, 'lancer', 'se', 26));
    expect(decide(mode, obs)).toContainEqual({ kind: 'research', upgrade: 'aegis_projectors', ifAffordable: true });
    obs.entities = obs.entities.filter(e => e.side === 'nw');
    expect(decide(mode, obs)).toContainEqual({ kind: 'research', upgrade: 'night_cloak', ifAffordable: true });
    obs.research.available = [];
    obs.research.inProgress = ['night_cloak'];
    expect(decide(mode, obs).some(i => i.kind === 'research')).toBe(false);
  });

  it('researches Lancer Lens once 3 enemy aircraft fly under the Lancers (veteran, and the starter with knob lens)', async () => {
    const obs = fixture();
    obs.research.available = ['aegis_projectors', 'night_cloak', 'lancer_lens'];
    obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 10000;
    obs.entities.push(ship(1, 'lancer', 'nw', 20, 20), ship(2, 'lancer', 'nw', 21, 20));
    const air = (id: number, x: number): Entity => ({ ...ship(id, 'interceptor', 'se', x, 21), plane: 'sky' });
    // The starter's standard tier skips the Lens like the standard bot; knob lens turns it on.
    const source = mode === 'policy' ? await starterScript('orbit', { lens: true }) : undefined;
    const lens = (): boolean => decide(mode, obs, matchData, source).some(i => i.kind === 'research' && i.upgrade === 'lancer_lens');
    obs.entities.push(air(3, 20), air(4, 21), air(5, 20 + STATS.lancer.range + 2));
    expect(lens()).toBe(false);
    obs.entities.push(air(6, 22));
    expect(lens()).toBe(mode !== 'standard');
    // Switched off (or already researching): the usual Orbit research instead.
    obs.research.available = ['aegis_projectors', 'night_cloak'];
    expect(lens()).toBe(false);
  });

  it('buys an array past the cap while the solar bank has room, not once it is full', () => {
    const obs = fixture();
    // Below the energy that stops array purchases; enough arrays to cover the base cap at their day-and-night mean
    // plus the usual spare.
    obs.res.energy = obs.res.freeEnergy = 100;
    const mean = (matchData.rules.economy.solarRate * (1 + matchData.rules.orbit.solarNight)) / 2;
    for (let i = 0; i < Math.ceil(obs.res.energyCap / mean) + 1; i++) obs.entities.push(ship(i + 1, 'solar', 'nw'));
    const solar = (energyBank: number): boolean =>
      decide(mode, { ...obs, res: { ...obs.res, energyBank } }).some(i => i.kind === 'queue_add' && i.item === 'solar');
    expect(solar(0)).toBe(true);
    expect(solar(matchData.rules.economy.solarBankMax)).toBe(false);
  });

  it('uses free Sun lance through a lit cluster, honoring cooldown, energy and night', () => {
    const obs = fixture();
    obs.sun.angle = 0;
    obs.entities.push(ship(1, 'lancer', 'nw', 20, 24),
      ship(2, 'bastion', 'se', 26, 24), ship(3, 'bastion', 'se', 27.5, 24));
    const casts = decide(mode, obs).filter(i => i.kind === 'sun_lance');
    expect(casts).toHaveLength(1);
    expect(casts[0]).toMatchObject({ units: ['e_1'], y: 24 });
    expect(decide(mode, obs).some(i => (i.kind === 'move' || i.kind === 'attack') && i.units.includes('e_1'))).toBe(false);
    obs.entities[0]!.abilityReady = obs.tick + 1;
    expect(decide(mode, obs).some(i => i.kind === 'sun_lance')).toBe(false);
    obs.entities[0]!.abilityReady = 0;
    obs.res.energy = obs.res.freeEnergy = matchData.rules.orbit.lanceEnergy - 1;
    expect(decide(mode, obs).some(i => i.kind === 'sun_lance')).toBe(false);
    obs.res.energy = obs.res.freeEnergy = 2000;
    obs.sun.angle = Math.PI / 2;
    expect(decide(mode, obs).some(i => i.kind === 'sun_lance')).toBe(false);
  });

  it('casts researched Aegis for focused nearby allies without overwriting its root', () => {
    const obs = fixture();
    obs.entities.push(ship(1, 'bastion', 'nw', 20, 24), ship(2, 'lancer', 'nw', 21, 24),
      ship(3, 'lancer', 'se', 24, 24), ship(4, 'lancer', 'se', 24, 25));
    expect(decide(mode, obs).some(i => i.kind === 'aegis')).toBe(false);
    obs.research.completed = ['aegis_projectors'];
    expect(decide(mode, obs)).toContainEqual({ kind: 'aegis', units: ['e_1'] });
    expect(decide(mode, obs).some(i => (i.kind === 'move' || i.kind === 'attack') && i.units.includes('e_1'))).toBe(false);
    obs.entities[0]!.abilityReady = obs.tick + 1;
    expect(decide(mode, obs).some(i => i.kind === 'aegis')).toBe(false);
    obs.entities[0]!.abilityReady = 0;
    obs.entities.pop();
    expect(decide(mode, obs).some(i => i.kind === 'aegis')).toBe(false);
  });

  it('stages researched cloak raids through night while Bastions guard income', () => {
    const obs = fixture();
    obs.sun.angle = Math.PI / 2;
    obs.research.completed = ['night_cloak'];
    obs.entities.push(ship(1, 'skiff', 'nw', 20, 24), ship(2, 'solar', 'se', 30, 20),
      ship(3, 'bastion', 'nw', 20, 10), ship(4, 'solar', 'nw', 18, 10));
    const out = decide(mode, obs);
    expect(out.find(i => i.kind === 'move' && i.units.includes('e_1'))).toMatchObject({ formation: 'wedge', y: 24 });
    expect(out.find(i => i.kind === 'move' && i.units.includes('e_3'))).toMatchObject({ x: 18, y: 10, formation: 'escort' });
    obs.entities.push(ship(5, 'bastion', 'se', 30, 20));
    expect(decide(mode, obs).some(i => i.kind === 'move' && i.units.includes('e_1') && i.y === 24 && i.formation === 'wedge')).toBe(false);
  });

  it.each([
    ['skiff', 'bastion'], ['bastion', 'lancer'], ['lancer', 'bastion'],
  ] as const)('counters scouted %s with additional %s production', (enemy, counter) => {
    const obs = fixture();
    const stats = matchData.rules.stats.lancer;
    const beam = matchData.rules.spire.dmg / matchData.rules.spire.cooldown;
    const damage = stats.dmg / stats.cooldown;
    const fleet = Math.max(mode === 'standard' ? 2 : 3,
      Math.ceil(Math.sqrt(2.7 * matchData.rules.spire.hp.orbit * beam / ((stats.hp + stats.shield) * damage))));
    for (let i = 0; i < fleet; i++) obs.entities.push(ship(i + 1, 'lancer', 'nw'));
    obs.entities.push(ship(90, 'skiff', 'nw'), ship(91, 'skiff', 'nw'), ship(92, 'bastion', 'nw'), ship(93, 'skiff', 'nw'));
    expect(decide(mode, obs).some(i => i.kind === 'queue_add')).toBe(false);
    obs.entities.push(ship(100, enemy, 'se', 25));
    expect(decide(mode, obs)).toContainEqual({ kind: 'queue_add', item: counter });
  });

  it('reserves a counter before replacing economy once the Sky screen is established', () => {
    const obs = fixture();
    obs.tick = 2000;
    obs.res.alloy = obs.res.freeAlloy = 0;
    obs.res.energy = obs.res.freeEnergy = 0;
    obs.entities.push(ship(1, 'solar', 'nw'), ship(2, 'lancer', 'se', 25));
    // Veteran preserves shared energy for a missing Sky screen; isolate Orbit's replacement priority.
    for (let i = 0; i < 4; i++) {
      const interceptor = ship(10 + i, 'interceptor', 'nw');
      interceptor.plane = 'sky';
      delete interceptor.shield;
      delete interceptor.maxShield;
      obs.entities.push(interceptor);
    }
    expect(decide(mode, obs)).toContainEqual({ kind: 'queue_add', item: 'bastion' });
  });

  it('queues a warship before arrays when every array is dead and armed Skiffs are in sight', () => {
    const obs = fixture();
    // Below the energy that stops array purchases: without the threat the seat rebuilds arrays first.
    obs.res.energy = obs.res.freeEnergy = 100;
    for (let i = 0; i < 4; i++) {
      const interceptor = ship(10 + i, 'interceptor', 'nw');
      interceptor.plane = 'sky';
      delete interceptor.shield;
      delete interceptor.maxShield;
      obs.entities.push(interceptor);
    }
    const first = (): AgentCommandIntent | undefined => decide(mode, obs).find(i => i.kind === 'queue_add');
    expect(first()).toMatchObject({ kind: 'queue_add', item: 'solar' });
    obs.entities.push(ship(100, 'skiff', 'se', 25), ship(101, 'skiff', 'se', 26));
    const counter = first();
    expect(counter?.kind === 'queue_add' && ['skiff', 'bastion', 'lancer'].includes(counter.item)).toBe(true);
  });

  it('ignores unscouted armies and sightings outside Orbit', () => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'orbit' } as const;
    const before = g.observe(seat, 0);
    const hidden = g.sim.add('bastion', g.sim.armyIndex('se'), 'orbit', 46, 46);
    const after = g.observe(seat, 0);
    // Unscouted: Blue has no name for it and its observation shows no such ship.
    expect(g.sim.aliasOf(g.sim.armyIndex('nw'), hidden.id)).toBe(0);
    expect(after.entities.some(e => e.side === 'se' && e.kind === 'bastion')).toBe(false);
    expect(decide(mode, after)).toEqual(decide(mode, before));
    const obs = fixture();
    const baseline = decide(mode, obs).filter(i => i.kind === 'queue_add');
    const elsewhere = ship(101, 'skiff', 'se');
    elsewhere.plane = 'sky';
    obs.entities.push(elsewhere);
    expect(decide(mode, obs).filter(i => i.kind === 'queue_add')).toEqual(baseline);
  });

  it('keeps Bastions with income while Skiffs raid as a separate group', () => {
    const obs = fixture();
    obs.entities.push(ship(1, 'bastion', 'nw', 20, 10), ship(2, 'bastion', 'nw', 21, 10),
      ship(3, 'solar', 'nw', 18, 10), ship(4, 'skiff', 'nw'), ship(5, 'skiff', 'nw', 20.5),
      ship(6, 'solar', 'se', 23));
    expect(decide(mode, obs)).toEqual(expect.arrayContaining([
      { kind: 'move', units: ['e_1', 'e_2'], x: 18, y: 10, mode: 'move', formation: 'escort', escort: 'e_1' },
      { kind: 'attack', units: ['e_4', 'e_5'], target: 'e_6' },
    ]));
  });

  it('counts shields when deciding whether a Skiff raid has a clear advantage', () => {
    const obs = fixture();
    obs.entities.push(ship(1, 'skiff', 'nw'), ship(2, 'skiff', 'nw', 20.4), ship(3, 'lancer', 'se', 23));
    expect(decide(mode, obs)).toContainEqual({ kind: 'attack', units: ['e_1', 'e_2'], target: 'e_3' });
    obs.entities[0]!.shield = 0;
    obs.entities[1]!.shield = 0;
    const retreat = decide(mode, obs).find(i => i.kind === 'move' && i.units.includes('e_1'));
    expect(retreat).toMatchObject({ kind: 'move', units: ['e_1', 'e_2'], formation: 'line' });
    if (retreat?.kind === 'move') expect(retreat.x).toBeLessThan(20);
  });

  it('withdraws an already-attacking fleet rather than deliberately trading evenly', () => {
    const obs = fixture();
    const own = ship(1, 'lancer', 'nw');
    own.state = 'attacking';
    obs.entities.push(own, ship(2, 'lancer', 'se', 23));
    const out = decide(mode, obs);
    expect(out.some(i => i.kind === 'attack')).toBe(false);
    expect(out.find(i => i.kind === 'move' && i.units.includes('e_1'))).toMatchObject({ formation: 'line' });
  });

  it('counts independent station point defence even when the segment beam is disabled', () => {
    const obs = structuredClone(fixture());
    const data = structuredClone(matchData);
    data.rules.spire.dmg = 0;
    const own = ship(1, 'skiff', 'nw');
    own.state = 'attacking';
    obs.entities.push(own, { ...ship(2, 'lancer', 'se', 23), kind: 'spire', hp: 100, maxHp: 100 });
    expect(decide(mode, obs, data).find(i => i.kind === 'move' && i.units.includes('e_1'))).toMatchObject({ formation: 'line' });
    // Rules are immutable within a match, and the native bot caches their compiled tables by identity.
    const withoutPd = structuredClone(data);
    withoutPd.rules.orbit.stationPdDamage = 0;
    expect(decide(mode, obs, withoutPd).some(i => i.kind === 'move' && i.units.includes('e_1'))).toBe(false);
  });

  it('gathers long-range Lancers in a line by the derelict ruin, not in its chamber, before an undersized siege', () => {
    const obs = fixture();
    obs.entities.push(ship(1, 'lancer', 'nw'));
    // The ruin post: beyond the hull's outer edge on the diagonal toward our corner, between two breaches.
    const g = ruin.derelict!;
    const gather = decide(mode, obs, ruin).find((i) => i.kind === 'move' && i.units.includes('e_1'));
    expect(gather).toMatchObject({ formation: 'line' });
    if (gather?.kind === 'move') {
      expect(Math.hypot(gather.x - g.x, gather.y - g.y)).toBeGreaterThan(g.hullOuter);
      expect(gather.x).toBe(gather.y);
      expect(gather.x).toBeLessThan(g.x);
    }
    expect(decide(mode, obs)).toContainEqual({ kind: 'move', units: ['e_1'], x: 24, y: 24, mode: 'move', formation: 'line' });
  });
});

for (const mode of ['standard', 'veteran', 'policy'] as const) describe(`derelict core: ${mode}`, () => {
  const core = (x: number, y: number, extra: Partial<Entity> = {}): Entity => ({
    id: 'e_7', kind: 'core', side: 'neutral', plane: 'orbit', x, y, hp: 500, maxHp: 500, state: 'idle', vents: 0, heat: 0, ...extra });
  const grapples = (out: AgentCommandIntent[]): boolean => out.some((i) => (i.kind === 'grapple' && i.asteroid === 'e_7')
    || (i.kind === 'macro' && i.action === 'harvest_core'));

  it('latches a tug in the open chamber onto the resting core, keeping a second tug on the rocks', () => {
    const obs = fixture();
    obs.entities.push(ship(1, 'tug', 'nw', 23, 24), ship(2, 'tug', 'nw', 10, 10), core(24, 24));
    const out = decide(mode, obs, ruin);
    expect(grapples(out)).toBe(true);
    if (mode !== 'policy') expect(out).toContainEqual({ kind: 'grapple', units: ['e_1'], asteroid: 'e_7' });
    // One tug alone stays on the rocks.
    obs.entities = obs.entities.filter((e) => e.id !== 'e_2');
    expect(grapples(decide(mode, obs, ruin))).toBe(false);
    // Without the ruin there is no core work at all.
    const open = matchData;
    obs.entities.push(ship(2, 'tug', 'nw', 10, 10));
    expect(grapples(decide(mode, obs, open))).toBe(false);
  });

  it('stays out while armed enemies hold the chamber', () => {
    const obs = fixture();
    obs.entities.push(ship(1, 'tug', 'nw', 6, 24), ship(2, 'tug', 'nw', 10, 10), core(24, 24), ship(3, 'skiff', 'se', 24.5, 24));
    expect(grapples(decide(mode, obs, ruin))).toBe(false);
  });

  it('vents a hot towed core outside the ruin and leaves the chamber before radiation kills', () => {
    const obs = fixture();
    const tug: Entity = { ...ship(1, 'tug', 'nw', 12, 12), link: 'e_7', state: 'towing' };
    obs.entities.push(tug, ship(2, 'tug', 'nw', 10, 10), core(12, 12, { state: 'towed', heat: 85, vents: 0, link: 'e_1' }));
    expect(decide(mode, obs, ruin)).toContainEqual({ kind: 'vent', units: ['e_1'] });
    const worn = { ...ship(4, 'lancer', 'nw', 23.5, 24), hp: 40, shield: 0 };
    obs.entities.push(worn);
    expect(decide(mode, obs, ruin).some((i) => i.kind === 'move' && i.units.includes('e_4') && Math.hypot(i.x - 24, i.y - 24) > ruin.derelict!.hullOuter)).toBe(true);
  });

  it('re-checks a core tug in the chamber against combat damage too, not just radiation, and gets out', () => {
    const g = ruin.derelict!;
    const period = g.open + g.closed + 2 * g.turn;
    // Hull for radiation alone through this window and the next sealed span, with room to spare.
    const hp = Math.ceil(3 * ruin.rules.orbit.derelictRadiation * period / TICK_RATE);
    const obs = fixture();
    obs.entities.push({ ...ship(1, 'tug', 'nw', 24, 24), link: 'e_7', state: 'towing', hp, maxHp: hp, shield: 0 }, ship(2, 'tug', 'nw', 10, 10),
      core(24, 24, { state: 'towed', heat: 50, vents: 0, link: 'e_1' }));
    const enemies = (d: number): Entity[] => [ship(5, 'bastion', 'se', 24 + d, 24), ship(6, 'bastion', 'se', 24, 24 + d), ship(8, 'bastion', 'se', 24 + d, 24 + d)];
    // Armed enemies by the ruin but out of reach: it cools the core in the chamber.
    obs.entities.push(...enemies(g.hullOuter + 1));
    const cools = (out: AgentCommandIntent[]): boolean => !out.some((i) => (i.kind === 'release' && i.units.includes('e_1'))
      || (i.kind === 'macro' && i.action === 'haul_core') || (i.kind === 'move' && i.units.includes('e_1') && Math.hypot(i.x - 24, i.y - 24) > g.ringOuter));
    expect(cools(decide(mode, obs, ruin))).toBe(true);
    // The same enemies in the chamber, shooting it: the same hull no longer lasts until the window after next.
    obs.entities = obs.entities.filter((e) => e.side !== 'se').concat(enemies(1));
    expect(cools(decide(mode, obs, ruin))).toBe(false);
  });

  // The observation at `tick`: its clock and the public derelict windows from it.
  const at = (obs: Observation, tick: number): Observation => {
    const g = ruin.derelict!;
    obs.tick = tick;
    obs.schedule = obs.schedule.filter((s) => s.kind !== 'derelict_open');
    for (const k of [0, 1]) {
      const w = openWindow(g, tick, k);
      obs.schedule.push({ kind: 'derelict_open', tick: w, until: w + g.open, x: g.x, y: g.y });
    }
    return obs;
  };
  const orders = (out: AgentCommandIntent[], id: string): AgentCommandIntent[] => out.filter((i) => ('units' in i && i.units.includes(id)) || i.kind === 'macro');
  const outward = (out: AgentCommandIntent[], id: string): boolean => out.some((i) => (i.kind === 'release' && i.units.includes(id))
    || (i.kind === 'macro' && i.action === 'haul_core') || (i.kind === 'move' && i.units.includes(id) && Math.hypot(i.x - 24, i.y - 24) > ruin.derelict!.ringOuter));

  it('a committed tug grabs the core on the open window and tows it out on the next one, holding while sealed', () => {
    const g = ruin.derelict!;
    const period = g.open + g.closed + 2 * g.turn;
    // 100 hull lasts until it is out with the core on the next window, not through the one after it.
    const obs = at(fixture(), 0);
    obs.entities.push({ ...ship(1, 'tug', 'nw', 23, 24), hp: 100, maxHp: 150 }, ship(2, 'tug', 'nw', 10, 10), core(24, 24));
    expect(grapples(decide(mode, obs, ruin))).toBe(true);
    expect(outward(decide(mode, obs, ruin), 'e_1')).toBe(false);
    // Latched on as the gates seal: it holds the core inside (no exit orders) while the ring is shut.
    obs.entities = [{ ...ship(1, 'tug', 'nw', 24, 24), hp: 100, maxHp: 150, link: 'e_7', state: 'towing' }, ship(2, 'tug', 'nw', 10, 10),
      core(24, 24, { state: 'towed', heat: 0, vents: 0, link: 'e_1' })];
    for (const t of [g.open + g.turn, g.open + g.turn + g.closed / 2]) expect(orders(decide(mode, at(obs, t), ruin), 'e_1')).toEqual([]);
    // As the next window opens it tows the core out.
    expect(outward(decide(mode, at(obs, period - 1), ruin), 'e_1')).toBe(true);
  });

  it('a tug that cannot last from the chamber to the next exit does not set out', () => {
    const g = ruin.derelict!;
    const sets = (hp: number): boolean => {
      const obs = at(fixture(), 0);
      obs.entities.push({ ...ship(1, 'tug', 'nw', 24, 24 - g.hullOuter - 1), hp, maxHp: 150 }, ship(2, 'tug', 'nw', 10, 10));
      return decide(mode, obs, ruin).some((i) => (i.kind === 'macro' && i.action === 'harvest_core')
        || (i.kind === 'move' && i.units.includes('e_1') && Math.hypot(i.x - 24, i.y - 24) < 1));
    };
    expect(sets(150)).toBe(true);
    expect(sets(20)).toBe(false);
  });

  it('a worn ship sealed in holds until the window nears, then leaves: no pacing at the shut gate', () => {
    const g = ruin.derelict!;
    const period = g.open + g.closed + 2 * g.turn;
    const obs = fixture();
    // Lasts until the coming window, not through it to the next one.
    obs.entities.push({ ...ship(4, 'lancer', 'nw', 23.5, 24), hp: 60, shield: 0 });
    for (const t of [g.open + g.turn, g.open + g.turn + 20, g.open + g.turn + g.closed / 2]) {
      expect(decide(mode, at(obs, t), ruin).some((i) => i.kind === 'move' && i.units.includes('e_4'))).toBe(false);
    }
    expect(decide(mode, at(obs, period - 1), ruin).some((i) => i.kind === 'move' && i.units.includes('e_4') && Math.hypot(i.x - 24, i.y - 24) > g.hullOuter)).toBe(true);
  });

  it('tows a cool core home to its own Orbit segment to cash it in', () => {
    const obs = fixture();
    const tug: Entity = { ...ship(1, 'tug', 'nw', 14, 14), link: 'e_7', state: 'towing' };
    obs.entities.push(tug, ship(2, 'tug', 'nw', 10, 10), core(14, 14, { state: 'towed', heat: 10, vents: 0, link: 'e_1' }));
    const out = decide(mode, obs, ruin);
    const home = ruin.armies.find((a) => a.id === 'nw')!.spireAt;
    const haul = out.find((i) => (i.kind === 'move' && i.units.includes('e_1')) || (i.kind === 'macro' && i.action === 'haul_core'));
    expect(haul).toBeDefined();
    if (haul?.kind === 'move') expect([haul.x, haul.y]).toEqual([home.x, home.y]);
    // Too hot to make it home: no tow home (vent, drop or cool it instead).
    obs.entities = obs.entities.map((e) => (e.id === 'e_7' ? { ...e, heat: 95 } : e));
    const hot = decide(mode, obs, ruin);
    expect(hot.some((i) => (i.kind === 'move' && i.units.includes('e_1') && i.x === home.x && i.y === home.y) || (i.kind === 'macro' && i.action === 'haul_core'))).toBe(false);
  });
});

// The derelict-core audit's bot fixes (docs/research/derelict-core-audit.md), each decided by both armies of the C2
// duel: se's situation is nw's turned half round the map, so its orders must be nw's turned exactly.
for (const mode of ['standard', 'veteran', 'policy'] as const) describe(`derelict core audit fixes, C2 mirror: ${mode}`, () => {
  const size = ruin.rules.map.size;
  const g = ruin.derelict!;
  const turn = (team: 'nw' | 'se', x: number, y: number): { x: number; y: number } => (team === 'nw' ? { x, y } : { x: size - x, y: size - y });
  const other = (team: 'nw' | 'se'): 'nw' | 'se' => (team === 'nw' ? 'se' : 'nw');
  /** A unit of `side` at nw-frame point (x, y), turned into `team`'s frame. */
  const at = (team: 'nw' | 'se', id: number, kind: UnitKind, side: 'nw' | 'se', x: number, y: number, extra: Partial<Entity> = {}): Entity => {
    const p = turn(team, x, y);
    return { ...ship(id, kind, side, p.x, p.y), ...extra };
  };
  const core = (team: 'nw' | 'se', extra: Partial<Entity> = {}): Entity => {
    const p = turn(team, 24, 24);
    return { id: 'e_7', kind: 'core', side: 'neutral', plane: 'orbit', x: p.x, y: p.y, hp: 500, maxHp: 500, state: 'idle', vents: 0, heat: 0, ...extra };
  };
  const seat = (team: 'nw' | 'se', rules: (data: MatchData) => void = () => {}): { obs: Observation; data: MatchData } => {
    const game = createGame({ seed: 3 });
    const obs = game.observe({ team, role: 'orbit' }, 0);
    obs.entities = [];
    obs.queue = [];
    obs.res.alloy = obs.res.freeAlloy = 2000;
    obs.res.energy = obs.res.freeEnergy = 2000;
    const data = game.matchData({ team, role: 'orbit' });
    rules(data);
    return { obs, data };
  };
  /** Every unit order of one decision, its point turned back into nw's frame (so both armies' answers compare equal). */
  const canonical = (team: 'nw' | 'se', out: AgentCommandIntent[]): unknown[] => out.flatMap((i): unknown[] => {
    if (i.kind === 'move') return [{ ...i, ...turn(team, i.x, i.y) }];
    if (i.kind === 'grapple' || i.kind === 'release' || i.kind === 'stop' || i.kind === 'mine_asteroid') return [i];
    return [];
  });
  const both = (decideFor: (team: 'nw' | 'se') => AgentCommandIntent[]): AgentCommandIntent[] => {
    const nw = decideFor('nw');
    expect(canonical('se', decideFor('se'))).toEqual(canonical('nw', nw));
    return nw;
  };
  const inRuin = (out: AgentCommandIntent[], id: string): boolean => out.some((i) => (i.kind === 'move' && i.units.includes(id) && Math.hypot(i.x - g.x, i.y - g.y) < g.hullOuter)
    || (i.kind === 'grapple' && i.units.includes(id)) || (i.kind === 'macro' && i.action === 'harvest_core'));

  it('counts every tug against CORE_TUGS_MIN: with both on the rocks it borrows the empty miner nearest the ruin', () => {
    // Two tugs, both on mining assignments between loads (no cargo): the second one sets out for the core.
    const miners = (team: 'nw' | 'se', n: number): AgentCommandIntent[] => {
      const { obs, data } = seat(team);
      obs.entities.push(at(team, 1, 'tug', team, 6, 6, { miningAssigned: true, state: 'grappling' }));
      if (n > 1) obs.entities.push(at(team, 2, 'tug', team, 9, 9, { miningAssigned: true, state: 'grappling' }));
      return decide(mode, obs, data);
    };
    const out = both((team) => miners(team, 2));
    expect(inRuin(out, 'e_2') || out.some((i) => i.kind === 'move' && i.units.includes('e_2'))).toBe(true);
    expect(out.some((i) => 'units' in i && i.units.includes('e_1'))).toBe(false);
    // One tug in all keeps mining.
    expect(both((team) => miners(team, 1)).some((i) => 'units' in i && i.units.includes('e_1'))).toBe(false);
    // A miner carrying a load takes it home first.
    const loaded = both((team) => {
      const { obs, data } = seat(team);
      obs.entities.push(at(team, 1, 'tug', team, 6, 6, { miningAssigned: true, state: 'mining', cargoAlloy: 10 }), at(team, 2, 'tug', team, 9, 9, { miningAssigned: true, state: 'returning', cargoAlloy: 10 }));
      return decide(mode, obs, data);
    });
    expect(loaded.some((i) => 'units' in i && (i.units.includes('e_1') || i.units.includes('e_2')))).toBe(false);
  });

  it('never sends a tug into the ruin when the core is off (rules.orbit.coreEnabled)', () => {
    const free = (team: 'nw' | 'se', on: boolean): AgentCommandIntent[] => {
      const { obs, data } = seat(team, (d) => { d.rules.orbit.coreEnabled = on; });
      obs.entities.push(at(team, 1, 'tug', team, 12, 12), at(team, 2, 'tug', team, 6, 6));
      return decide(mode, obs, data);
    };
    expect(inRuin(both((team) => free(team, true)), 'e_1')).toBe(true);
    const off = both((team) => free(team, false));
    expect(inRuin(off, 'e_1') || inRuin(off, 'e_2')).toBe(false);
  });

  it('fights intruders from the gate mouth nearest them, outside the radiation, not in the chamber', () => {
    const out = both((team) => {
      const { obs, data } = seat(team);
      obs.entities.push(at(team, 1, 'lancer', team, 10, 10), at(team, 2, 'lancer', team, 10.5, 10), at(team, 3, 'bastion', other(team), 26, 24));
      return decide(mode, obs, data);
    });
    const fight = out.filter((i) => i.kind === 'move' && i.mode === 'fight' && (i.units.includes('e_1') || i.units.includes('e_2')));
    expect(fight.length).toBeGreaterThan(0);
    for (const i of fight) if (i.kind === 'move') {
      const r = Math.hypot(i.x - g.x, i.y - g.y);
      expect(r).toBeGreaterThan(g.ringOuter);
      expect(r).toBeLessThan(g.hullInner);
      // The gate the intruder (east of the core) would leave by: the east one.
      expect(i.x).toBeGreaterThan(g.x);
    }
  });

  it('a committed core tug keeps on toward the centre of the dark chamber until it sees the core, and no second tug leaves the rocks', () => {
    const orders = (team: 'nw' | 'se'): AgentCommandIntent[] => {
      const { obs, data } = seat(team);
      let think: (o: Observation) => AgentCommandIntent[];
      if (mode === 'policy') think = runInNewContext(`${STARTER_POLICIES.orbit}\ninit(bootstrap);\nthink;`, { bootstrap: data, log() {} }) as typeof think;
      else {
        const bot = createBot(team, 'orbit', mode);
        bot.init?.(data);
        think = (o) => bot.think(o);
      }
      // Sets out for the core (the second tug mining) on the open window...
      obs.entities.push(at(team, 1, 'tug', team, 12, 12), at(team, 2, 'tug', team, 6, 6, { miningAssigned: true, state: 'grappling' }));
      expect(inRuin(structuredClone(think(obs)), 'e_1')).toBe(true);
      // ...and a decision later it is inside the ring, worn too far to sit out the coming sealed span, the core not yet
      // in sight: it carries on in, no exit order, and the miner stays on its rock.
      obs.tick += periodOf('orbit');
      obs.entities[0] = at(team, 1, 'tug', team, 21, 21, { hp: 100, state: 'moving', tx: turn(team, 24, 24).x, ty: turn(team, 24, 24).y });
      return structuredClone(think(obs));
    };
    const out = both(orders);
    expect(out.some((i) => i.kind === 'move' && i.units.includes('e_1') && Math.hypot(i.x - g.x, i.y - g.y) > g.ringOuter)).toBe(false);
    expect(out.some((i) => 'units' in i && i.units.includes('e_2'))).toBe(false);
  });

  it('a tied race backs the tug out of the radiation while the fleet holds the rival gate mouth from outside the ring', () => {
    const out = both((team) => {
      const { obs, data } = seat(team);
      // Ours and a rival tug both in grapple reach of the resting core: nobody latches.
      obs.entities.push(at(team, 1, 'tug', team, 23, 23, { state: 'grappling' }), at(team, 2, 'tug', team, 6, 6), at(team, 4, 'lancer', team, 10, 10),
        at(team, 3, 'tug', other(team), 25, 25, { state: 'grappling' }), core(team));
      return decide(mode, obs, data);
    });
    expect(out.some((i) => (i.kind === 'grapple' && i.units.includes('e_1')) || (i.kind === 'macro' && i.action === 'harvest_core'))).toBe(false);
    const back = out.find((i) => i.kind === 'move' && i.units.includes('e_1'));
    expect(back?.kind === 'move' && Math.hypot(back.x - g.x, back.y - g.y)).toBeGreaterThan(g.hullOuter);
    const hold = out.find((i) => i.kind === 'move' && i.units.includes('e_4'));
    expect(hold).toMatchObject({ mode: 'fight' });
    if (hold?.kind === 'move') {
      expect(Math.hypot(hold.x - g.x, hold.y - g.y)).toBeGreaterThan(g.ringOuter);
      expect(Math.hypot(hold.x - g.x, hold.y - g.y)).toBeLessThan(g.hullInner);
    }
  });
});

// Orbit bots racing each other for the core in the sim: a quiet open map (no rocks, harmless Spires), only the Orbit
// seats deciding and nothing produced, so the race is between the ships each army is given, placed in its own frame.
describe('derelict core races between Orbit bots', () => {
  /** Race until `until(ruin geometry)` or a lift; every tick checked against the map's rotation group when the armies match. */
  function race(slots: 2 | 4, lancers: readonly number[], until: (g: DerelictGeometry) => number): {
    ruin: DerelictGeometry; tied: number[]; reached: Set<number>; liftedBy: number; asymmetry: string | undefined; chamberShips: number; tugInRuin: number[];
  } {
    const g = new AgentCommandGame(5, { terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, stationPdDamage: 0 }, map: { params: { slots } } });
    const s = g.sim;
    const ruinG = s.derelict!;
    const ticks = until(ruinG);
    for (const a of s.allArmies) {
      const k = s.armyFrame[a]!;
      s.add('tug', a, 'orbit', rotX(k, 9, 12, s.size), rotY(k, 9, 12, s.size));
      for (let i = 0; i < lancers[a]!; i++) s.add('lancer', a, 'orbit', rotX(k, 10 + i, 10, s.size), rotY(k, 10 + i, 10, s.size));
    }
    const seats = s.allArmies.map((a) => ({ team: armyIdOfSlot(s.armySlot[a]!, s.sides), role: 'orbit' as const }));
    const bots = seats.map((seat) => {
      const bot = createBot(seat.team, 'orbit', 'standard');
      bot.init?.(g.matchData(seat));
      return bot;
    });
    const mirror = lancers.every((n) => n === lancers[0]);
    const tied = new Set<number>();
    const reached = new Set<number>();
    // Ticks some tug spent in the ruin's chamber, and own warships ever in it (the contest stays outside the ring).
    const tugInRuin: number[] = [];
    let chamberShips = 0;
    let liftedBy = -1;
    let asymmetry: string | undefined;
    while (g.tick < ticks && liftedBy < 0) {
      if (g.tick % BOT_PERIOD === 0) {
        const out = seats.map((seat, i) => bots[i]!.think(g.observe(seat, 0)));
        s.round(() => seats.forEach((seat, i) => {
          for (const intent of out[i]!) if (intent.kind !== 'queue_add' && intent.kind !== 'research') g.apply(seat, intent, { source: 'bot' });
        }));
      }
      g.step();
      const core = s.derelictCore()!;
      if (core.state === 'towed') liftedBy = s.alive(core.link)!.side;
      const near = new Set<number>();
      for (const e of s.ents) {
        if (e.dead || e.plane !== 'orbit') continue;
        const r = Math.hypot(e.x - ruinG.x, e.y - ruinG.y);
        if (e.kind === 'tug' && Math.hypot(e.x - core.x, e.y - core.y) <= s.econ.grappleReach) near.add(e.side);
        if (e.kind === 'tug' && r < ruinG.ringInner && tugInRuin.at(-1) !== g.tick) tugInRuin.push(g.tick);
        if (e.kind === 'lancer' && r < ruinG.ringInner) chamberShips++;
      }
      for (const a of near) reached.add(a);
      if (core.state === 'idle' && near.size > 1) tied.add(openWindow(ruinG, g.tick));
      if (mirror && !asymmetry) asymmetry = orbitAsymmetry(s);
    }
    return { ruin: ruinG, tied: [...tied], reached, liftedBy, asymmetry, chamberShips, tugInRuin };
  }
  const { coreTies, coreTieRest } = TIERS.standard;

  it('C2 mirror, tugs only: both race on every window, tie, back out, and rest coreTieRest after coreTies tied windows', () => {
    // Through the rest that follows the coreTies-th tied window.
    const r = race(2, [0, 0], (g) => openWindow(g, 0, coreTies - 1) + coreTieRest);
    expect(r.asymmetry).toBeUndefined();
    expect(r.liftedBy).toBe(-1);
    expect([...r.reached].sort()).toEqual([0, 1]);
    // One tie on each of the first coreTies windows; after the last of them nobody's tug enters the chamber again.
    expect(r.tied).toEqual(Array.from({ length: coreTies }, (_, k) => openWindow(r.ruin, 0, k)));
    const restFrom = r.tied.at(-1)! + r.ruin.open;
    expect(r.tugInRuin.filter((t) => t > restFrom)).toEqual([]);
    expect(r.tugInRuin.some((t) => t > openWindow(r.ruin, 0, 1))).toBe(true);
  });

  it('C2 and C4 mirrors with fleets: every army contests the same way and the fleets fight outside the radiation', () => {
    for (const slots of [2, 4] as const) {
      const r = race(slots, Array.from({ length: slots }, () => 2), (g) => openWindow(g, 0, 2));
      expect(r.asymmetry).toBeUndefined();
      expect(r.liftedBy).toBe(-1);
      expect(r.reached.size).toBe(slots);
      expect(r.tied.length).toBeGreaterThan(0);
      expect(r.chamberShips).toBe(0);
    }
  });

  it('an asymmetric pair: after the tie the side whose fleet holds the gates lifts the core', () => {
    const r = race(2, [3, 0], (g) => openWindow(g, 0, 2));
    expect(r.tied.length).toBeGreaterThan(0);
    expect(r.liftedBy).toBe(0);
    expect(r.chamberShips).toBe(0);
  });
});

describe('derelict core macros', () => {
  it('harvest_core sends the nearest free tug into the ruin, then latches; haul_core tows the core home', () => {
    const game = createGame({ seed: 3 });
    const seat = { team: 'nw', role: 'orbit' } as const;
    // The starting tug is the only one: it heads for the ruin centre (the chamber hides the core from outside).
    const tug = game.sim.ents.find((e) => !e.dead && e.kind === 'tug' && e.side === 0)!;
    expect(game.apply(seat, { kind: 'macro', action: 'haul_core' })).toMatchObject({ ok: false });
    expect(game.apply(seat, { kind: 'macro', action: 'harvest_core' }).ok).toBe(true);
    expect(tug.order).toMatchObject({ k: 'move', x: 24, y: 24 });
    // Held at the gate mouth while sealed; inside, the core is in sight and the macro latches on.
    for (let i = 0; i < toTicks(60) && !tug.link; i++) {
      if (i % 10 === 0) game.apply(seat, { kind: 'macro', action: 'harvest_core' });
      game.step();
    }
    expect(game.sim.alive(tug.link)?.kind).toBe('core');
    expect(game.apply(seat, { kind: 'macro', action: 'haul_core' }).ok).toBe(true);
    const seg = game.sim.armies[0]!.spire.orbit;
    expect(tug.order).toMatchObject({ k: 'move', x: seg.x, y: seg.y });
    expect(game.apply({ team: 'nw', role: 'sky' }, { kind: 'macro', action: 'harvest_core' })).toMatchObject({ ok: false });
  });
});

describe('standard Orbit scans', () => {
  it('scans the centre from 1:00, then every 3:00', () => {
    const obs = fixture();
    obs.res.scanReadyAt = 0;
    const bot = createBot(obs.army, 'orbit', 'standard');
    bot.init?.(matchData);
    const centre = { kind: 'scan', x: matchData.rules.map.size / 2, y: matchData.rules.map.size / 2 };
    const at = (seconds: number): AgentCommandIntent[] => {
      obs.tick = toTicks(seconds);
      return bot.think(obs);
    };
    // Decisions at least one standard period (1.5 s) apart.
    expect(at(58)).not.toContainEqual(centre);
    expect(at(60)).toContainEqual(centre);
    expect(at(238)).not.toContainEqual(centre);
    expect(at(240)).toContainEqual(centre);
  });
});

describe('public Orbit approach lanes', () => {
  // The Orbit starter is the built-in bot: it stages an idle tug as its own scout order, not at the lane centres the
  // retired light example used, so the invariants are mirrored scout orders and rocks targeted only once visible.
  // The derelict is off: its core (one object for both armies) would draw both tugs to the same world point.
  it.each([48, 64, 80] as const)('%s: keeps public lane data out of observations, stages mirrored scouts and targets only visible rocks', (size) => {
    const game = createGame({ seed: 91, options: { map: { params: { size } }, orbit: { derelictEnabled: false } } });
    const canonicalMoves: { x: number; y: number }[][] = [[], []];
    for (const team of ['nw', 'se'] as const) {
      const seat = { team, role: 'orbit' } as const;
      const data = game.matchData(seat);
      const obs = game.observe(seat, 0);
      data.orbitRegions = [
        { x: size / 4, y: size / 4, width: size / 8, height: size / 8, dx: 0.02, dy: 0.01, weight: 2, spread: 0.005 },
        { x: size * 3 / 4, y: size * 3 / 4, width: size / 8, height: size / 8, dx: -0.02, dy: -0.01, weight: 2, spread: 0.005 },
        { x: size / 3, y: size / 4, width: 2, height: 2, dx: 0.02, dy: 0, weight: 0.5, spread: 0 },
        { x: size * 2 / 3, y: size * 3 / 4, width: 2, height: 2, dx: -0.02, dy: 0, weight: 0.5, spread: 0 },
      ];
      const tug = ship(900, 'tug', team, team === 'nw' ? 8.5 : size - 8.5, team === 'nw' ? 8.5 : size - 8.5);
      obs.entities = [tug]; obs.queue = []; obs.impacts = []; obs.tremors = [];
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      obs.res.scanReadyAt = 1e9;
      const policy = runInNewContext(`${STARTER_POLICIES.orbit}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
      policy.init(data);
      expect(obs).not.toHaveProperty('orbitRegions');
      // Decisions a period apart: a call sooner than that after one decides nothing.
      const period = periodOf('orbit');
      for (const tick of [0, period]) {
        obs.tick = tick;
        const out = structuredClone(policy.think(obs));
        expect(out.some((i) => i.kind === 'grapple')).toBe(false);
        const move = out.find((i) => i.kind === 'move' && i.units.includes(tug.id));
        expect(move?.kind).toBe('move');
        if (move?.kind !== 'move') throw new Error('Expected an idle scout order');
        canonicalMoves[team === 'nw' ? 0 : 1]!.push({ x: team === 'nw' ? move.x : size - move.x, y: team === 'nw' ? move.y : size - move.y });
      }
      obs.tick += period;
      obs.entities.push({ id: 'e_901', kind: 'asteroid', side: 'neutral', plane: 'orbit',
        x: tug.x, y: tug.y, hp: 100, maxHp: 100, state: 'drifting', rockSize: 'medium', resourceType: 'metal', volatile: false, resourceRemaining: 150 });
      expect(structuredClone(policy.think(obs))).toContainEqual({ kind: 'mine_asteroid', units: [tug.id], asteroid: 'e_901' });
    }
    expect(canonicalMoves[1]).toEqual(canonicalMoves[0]);
  });

  it.each([48, 64, 80] as const)('%s: keeps edge-region staging within bounds for both teams', (size) => {
    const game = createGame({ seed: 91, options: { map: { params: { size } }, orbit: { derelictEnabled: false } } });
    for (const team of ['nw', 'se'] as const) {
      const seat = { team, role: 'orbit' } as const;
      const data = game.matchData(seat);
      const obs = game.observe(seat, 0);
      data.orbitRegions = [
        { x: 0.125, y: size / 4, width: 0.125, height: 4, dx: 0.02, dy: 0, weight: 1, spread: 0 },
        { x: size - 0.125, y: size * 3 / 4, width: 0.125, height: 4, dx: -0.02, dy: 0, weight: 1, spread: 0 },
      ];
      obs.entities = [ship(900, 'tug', team)]; obs.queue = []; obs.impacts = []; obs.tremors = [];
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      obs.res.scanReadyAt = 1e9;
      const out = decide('policy', obs, data);
      const move = out.find((i) => i.kind === 'move' && i.units.includes('e_900'));
      expect(move?.kind).toBe('move');
      if (move?.kind !== 'move') throw new Error('Expected an edge-region scout order');
      expect(move.x).toBeGreaterThan(0);
      expect(move.x).toBeLessThan(size);
      expect(move.y).toBeGreaterThan(0);
      expect(move.y).toBeLessThan(size);
    }
  });
});
