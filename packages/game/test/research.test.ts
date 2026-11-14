import { afterEach, describe, expect, it } from 'vitest';
import { MATCH_DATA_MAX_BYTES } from 'playerthree';
import { t, validate } from 'playerthree/schema';
import { ABILITY_RULES, DEFAULT_RULES, INTENTS, PLANES, STATS, TRANSITS, UPGRADES, UNIT_KINDS, observationSchema, resolveUpgrade, toTicks, type MatchOptions, type Upgrade } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import { PLANE_INDEX } from '../src/sim/constants.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);

const original = UPGRADES.ascent_thrusters;
afterEach(() => { UPGRADES.ascent_thrusters = original; });

function game(options: MatchOptions = {}): AgentCommandGame {
  return createGame({ seed: 9, options: { economy: { startAlloy: 1000, startEnergy: 1000, spireAlloyRate: 0, solarRate: 0 }, research: { ascentThrustersTime: 0.1 }, ...options } });
}

function research(g: AgentCommandGame): void {
  expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' })).toEqual({ ok: true });
  g.step();
  g.step();
  expect(g.sim.armies[BLUE]!.research.has('ascent_thrusters')).toBe(true);
}

function fixtureUpgrade(overrides: Partial<Upgrade>): void {
  UPGRADES.ascent_thrusters = { ...original, ...overrides };
}

const observation = (g: AgentCommandGame) => g.observe({ team: 'nw', role: 'sky' }, -1);

describe('registry contract', () => {
  it('declares base Lancers, explicit capabilities and shared ability rule keys', () => {
    expect(UNIT_KINDS).toContain('lancer');
    expect(STATS.lancer.plane).toBe('orbit');
    expect(STATS.lancer.targets).toEqual(['orbit']);
    expect(STATS.interceptor.targets).toEqual(['sky']);
    expect(STATS.digger.capabilities).toMatchObject({ dig: true, carry: true, build: true });
    expect(STATS.bomber.capabilities.spotterDown).toBe(true);
    expect(STATS.interceptor.capabilities.capture).toBe(true);
    expect(STATS.tug.capabilities.tow).toBe(true);
    expect(ABILITY_RULES.ascend).toEqual({ energy: 'ascentEnergy', cooldown: 'ascentCooldown' });
    expect(resolveUpgrade(DEFAULT_RULES, 'ascent_thrusters')).toEqual({ alloy: 150, energy: 100, build: toTicks(30), plane: 'sky' });
    const g = game();
    expect(g.sim.canBuild(BLUE, 'lancer')).toBe(true);
    expect(g.sim.hasAbility(g.sim.armies[BLUE]!.spire.orbit, 'scan')).toBe(true);
    expect(g.sim.hasAbility(g.sim.armies[BLUE]!.spire.sky, 'scan')).toBe(false);
  });

  it('declares free Sun lance and rule-priced Orbit research unlocks', () => {
    expect(STATS.lancer.abilities).toContain('sun_lance');
    expect(STATS.bastion.abilities).not.toContain('aegis');
    expect(STATS.skiff.abilities).not.toContain('night_cloak');
    expect(resolveUpgrade(DEFAULT_RULES, 'aegis_projectors')).toEqual({ alloy: 100, energy: 100, build: toTicks(25), plane: 'orbit' });
    expect(resolveUpgrade(DEFAULT_RULES, 'night_cloak')).toEqual({ alloy: 125, energy: 100, build: toTicks(30), plane: 'orbit' });
    expect(validate(t.obj(INTENTS.sun_lance.params), { units: ['e_1'], x: 12, y: 14 }).ok).toBe(true);
    expect(validate(t.obj(INTENTS.aegis.params), { units: ['e_1'] }).ok).toBe(true);
  });

  it('declares integer structure footprints without changing body radii', () => {
    for (const [kind, size] of [['turret', 1], ['relay', 1], ['bulkhead', 1], ['shaft', 2], ['headframe', 3], ['spire', 3]] as const) {
      expect(STATS[kind].footprint).toEqual({ w: size, h: size });
      expect(Number.isInteger(STATS[kind].footprint.w)).toBe(true);
      expect(Number.isInteger(STATS[kind].footprint.h)).toBe(true);
    }
    expect(STATS.headframe.radius).toBe(0.8);
    expect(STATS.shaft.radius).toBe(0.8);
  });

  it('rejects unknown upgrade ids through the closed intent schema', () => {
    expect(validate(t.obj(INTENTS.research.params), { upgrade: 'unknown' }).ok).toBe(false);
  });

  it('keeps capped busy observations compact without repeating static registries per entity', () => {
    const g = game();
    research(g);
    // Fill the observation cap, including active ascent timestamps on every raider.
    for (let i = 0; i < 600; i++) {
      const e = g.sim.spawnUnit(BLUE, 'interceptor', 'sky');
      e.transitKind = TRANSITS.ascend;
      e.transitAt = 40;
      e.transitUntil = 440;
      e.transitReady = 900;
    }
    for (const role of PLANES) {
      const obs = g.observe({ team: 'nw', role }, -1);
      expect(obs.entities).toHaveLength(600);
      expect(validate(observationSchema, obs).ok).toBe(true);
      // A fixed wire-size regression, not a machine-dependent think-time assertion.
      expect(Buffer.byteLength(JSON.stringify(obs))).toBeLessThan(128 * 1024);
      // The seat's default scope keeps only its own plane's share of the crowd.
      const scoped = g.observe({ team: 'nw', role }, -1, [role]);
      expect(validate(observationSchema, scoped).ok).toBe(true);
      expect(scoped.entities.every((e) => e.plane === role)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(scoped))).toBeLessThan(128 * 1024);
      expect(obs).not.toHaveProperty('match');
      expect(obs).not.toHaveProperty('rules');
      expect(obs).not.toHaveProperty('terrain');
      for (const e of obs.entities) {
        expect(e.stance).toBeUndefined();
        expect(e).not.toHaveProperty('capabilities');
        expect(e).not.toHaveProperty('abilities');
        expect(e).not.toHaveProperty('stats');
        expect(e).not.toHaveProperty('upgrades');
      }
    }
  });

  it('budgets the separate immutable match bootstrap independently of dynamic observations', () => {
    const g = game();
    const data = g.matchData({ team: 'nw', role: 'depths' });
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(MATCH_DATA_MAX_BYTES);
    for (let i = 0; i < 600; i++) g.sim.spawnUnit(BLUE, 'interceptor', 'sky');
    expect(g.matchData({ team: 'nw', role: 'depths' })).toEqual(data);
    expect(g.observe({ team: 'nw', role: 'depths' }, -1)).not.toHaveProperty('match');
  });
});

describe('research in the shared team queue', () => {
  it('research and unit production have independent work slots: a later lane entry free stock pays starts beside the head', () => {
    const g = game();
    const t = g.sim.armies[BLUE]!;
    expect(observation(g).research).toEqual({ available: ['ascent_thrusters', 'aegis_projectors', 'night_cloak', 'lancer_lens', 'drill_bits', 'shaped_charges'], inProgress: [], completed: [], seen: [] });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' })).toEqual({ ok: true });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'interceptor' })).toEqual({ ok: true });
    expect(observation(g).queue.map((entry) => entry.item)).toEqual(['ascent_thrusters', 'interceptor']);
    g.step();
    // The interceptor waits behind the research head in the Sky lane, but free stock covers its whole cost and its
    // producer is free (research has its own slot), so it starts the same tick.
    expect(t.queue.map((entry) => entry.started)).toEqual([true, true]);
    expect(t.alloy).toBe(1000 - 150 - STATS.interceptor.alloy);
    expect(t.energy).toBe(1000 - 100 - STATS.interceptor.energy);
    expect(observation(g).queue[0]).toMatchObject({ progress: 0.5, eta: 1, plane: 'sky', status: 'building' });
    expect(observation(g).research.inProgress).toEqual(['ascent_thrusters']);
    g.step();
    expect(t.queue.map((entry) => entry.item)).toEqual(['interceptor']);
    expect(t.queue[0]!.started).toBe(true);
    expect(t.alloy).toBe(1000 - 150 - STATS.interceptor.alloy);
    expect(t.energy).toBe(1000 - 100 - STATS.interceptor.energy);
    expect(observation(g).research.completed).toEqual(['ascent_thrusters']);
    expect(observation(g).research.available).toEqual(['aegis_projectors', 'night_cloak', 'lancer_lens', 'drill_bits', 'shaped_charges']);
    expect(g.sim.ents.filter((e) => e.side === BLUE && e.kind === 'interceptor').every((e) => g.sim.hasAbility(e, 'ascend'))).toBe(true);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' })).toEqual({ ok: false, code: 'blocked' });
    expect(validate(observationSchema, observation(g)).ok).toBe(true);
    expect(g.view('nw', { snapshot: true }).research).toEqual(observation(g).research);
  });

  it('shares lane funding and limits without blocking another plane or granting cross-role edits', () => {
    const g = game({ queue: { seatMax: 2, refundStarted: 0.5 } });
    const t = g.sim.armies[BLUE]!;
    t.energy = 0;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(true);
    expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_add', item: 'digger' }).ok).toBe(true);
    g.step();
    expect(t.queue.map(entry => entry.started)).toEqual([false, true]);
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_move', entry: 'q_2', index: 0 })).toEqual({ ok: false, code: 'invalid_target' });
    expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_move', entry: 'q_2', index: 0 })).toEqual({ ok: true });
    g.step();
    expect(t.queue[0]!.started).toBe(true);
    expect(t.queue[1]!.started).toBe(false);
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_cancel', entry: 'q_1' })).toEqual({ ok: false, code: 'invalid_target' });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_cancel', entry: 'q_1' })).toEqual({ ok: true });
    expect(observation(g).research.available).toEqual(['ascent_thrusters', 'aegis_projectors', 'night_cloak', 'lancer_lens', 'drill_bits', 'shaped_charges']);
    t.energy = 1000;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(true);
    g.step();
    const paid = { alloy: t.alloy, energy: t.energy };
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_cancel', entry: 'q_3' }).ok).toBe(true);
    expect(t.alloy).toBe(paid.alloy + 75);
    expect(t.energy).toBe(paid.energy + 50);
  });

  it('rejects wrong segments, duplicates and unmet upgrade prerequisites', () => {
    const g = game();
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(false);
    fixtureUpgrade({ requires: { upgrades: ['ascent_thrusters'] } });
    expect(observation(g).research.available).toEqual(['aegis_projectors', 'night_cloak', 'lancer_lens', 'drill_bits', 'shaped_charges']);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' })).toEqual({ ok: false, code: 'blocked' });
    fixtureUpgrade({ requires: { upgrades: [] } });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(true);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'ascent_thrusters' })).toEqual({ ok: false, code: 'blocked' });
    const clone = g.sim.clone();
    expect(clone.hash()).toBe(g.stateHash());
  });

  it.each([0, 0.5, 1])('removes paid research on segment loss and refunds fraction %s', (refund) => {
    const g = game({ research: { ascentThrustersTime: 30, segmentLossRefund: refund } });
    const t = g.sim.armies[BLUE]!;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(true);
    g.step();
    const paid = { alloy: t.alloy, energy: t.energy };
    g.sim.damage(t.spire.sky, t.spire.sky.hp, RED);
    g.step();
    expect(t.queue).toEqual([]);
    expect(t.alloy).toBe(paid.alloy + 150 * refund);
    expect(t.energy).toBe(paid.energy + 100 * refund);
    expect(observation(g).research).toEqual({ available: ['aegis_projectors', 'night_cloak', 'lancer_lens', 'drill_bits', 'shaped_charges'], inProgress: [], completed: [], seen: [] });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' })).toEqual({ ok: false, code: 'segment_destroyed' });
  });

  it('removes unpaid research on segment loss without creating a refund', () => {
    const g = game();
    const t = g.sim.armies[BLUE]!;
    t.energy = 0;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(true);
    g.step();
    const alloy = t.alloy;
    g.sim.damage(t.spire.sky, t.spire.sky.hp, RED);
    g.step();
    expect(t.queue).toEqual([]);
    expect(t.alloy).toBe(alloy);
    expect(t.energy).toBe(0);
  });
});

describe('generic upgrade effects and fogged reveal', () => {
  it('reveals ability research only after the enemy sees its effect, retaining knowledge afterwards', () => {
    const g = game();
    research(g);
    const s = g.sim;
    const unit = s.ents.find((e) => e.side === BLUE && e.kind === 'interceptor')!;
    const enemy = s.armies[RED]!.group;
    expect(enemy.seenResearch[BLUE]!.size).toBe(0);
    s.revealAbility(unit, 'ascend');
    expect(enemy.seenResearch[BLUE]!.size).toBe(0);
    const sky = s.vis[PLANE_INDEX.sky]!;
    sky[cellOfEnt(unit, 48)] = sky[cellOfEnt(unit, 48)]! | enemy.bit;
    expect(g.observe({ team: 'se', role: 'sky' }, -1).research.seen).toEqual([]);
    s.revealAbility(unit, 'ascend');
    expect(g.observe({ team: 'se', role: 'sky' }, -1).research.seen).toEqual([{ army: 'nw', upgrades: ['ascent_thrusters'] }]);
    s.vis[PLANE_INDEX.sky]!.fill(0);
    expect(g.observe({ team: 'se', role: 'sky' }, -1).research.seen).toEqual([{ army: 'nw', upgrades: ['ascent_thrusters'] }]);
  });

  it('applies unlocks generically and reveals the unlocked unit only when visible', () => {
    fixtureUpgrade({ effects: [{ kind: 'unlock', items: ['lancer'] }], reveal: { kind: 'unit', unit: 'lancer' } });
    const g = game();
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'queue_add', item: 'lancer' })).toEqual({ ok: false, code: 'blocked' });
    research(g);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'queue_add', item: 'lancer' }).ok).toBe(true);
    const e = g.sim.add('lancer', BLUE, 'orbit', 20, 20);
    expect(g.sim.armies[RED]!.group.seenResearch[BLUE]!.size).toBe(0);
    g.sim.scan(RED, e.x, e.y);
    expect(g.sim.armies[RED]!.group.seenResearch[BLUE]!.has('ascent_thrusters')).toBe(true);
  });

  it('applies stat selectors and scopes to existing and newly created units', () => {
    fixtureUpgrade({ scope: 'segment', effects: [
      { kind: 'modifier', target: { kinds: ['interceptor'] }, stat: 'hp', add: 40 },
      { kind: 'modifier', target: { kinds: ['interceptor'] }, stat: 'speed', multiply: 1.5 },
      { kind: 'modifier', target: { kinds: ['interceptor'] }, stat: 'dmg', add: 3 },
      { kind: 'modifier', target: { kinds: ['interceptor'] }, stat: 'range', add: 2 },
      { kind: 'modifier', target: { kinds: ['interceptor'] }, stat: 'cooldown', multiply: 0.5 },
      { kind: 'modifier', target: { kinds: ['interceptor'] }, stat: 'vision', add: 2 },
    ], reveal: { kind: 'modifier', stat: 'hp' } });
    const g = game();
    const s = g.sim;
    const e = s.ents.find((unit) => unit.side === BLUE && unit.kind === 'interceptor')!;
    e.hp -= 10;
    research(g);
    expect(e.maxHp).toBe(STATS.interceptor.hp + 40);
    expect(e.hp).toBe(STATS.interceptor.hp + 30);
    expect(s.baseSpeed(e)).toBe(STATS.interceptor.speed * 1.5 / 20);
    expect(s.stat(e).dmg).toBe(STATS.interceptor.dmg + 3);
    expect(s.stat(e).range).toBe(STATS.interceptor.range + 2);
    expect(s.stat(e).cooldown).toBe(STATS.interceptor.cooldown / 2);
    expect(s.stat(e).vision).toBe(STATS.interceptor.vision + 2);
    const fresh = s.add('interceptor', BLUE, 'sky', 20, 20);
    expect(fresh.hp).toBe(e.maxHp);
    const orbit = s.add('interceptor', BLUE, 'orbit', 20, 20);
    expect(s.stat(orbit).speed).toBe(STATS.interceptor.speed);
    expect(s.add('interceptor', RED, 'sky', 22, 20).maxHp).toBe(STATS.interceptor.hp);
    const copy = s.clone();
    const copied = copy.alive(e.id)!;
    expect(copy.stat(copied).dmg).toBe(s.stat(e).dmg);
    copied.plane = 'orbit';
    expect(copy.stat(copied).speed).toBe(STATS.interceptor.speed);
    expect(s.stat(e).speed).toBe(STATS.interceptor.speed * 1.5);
  });

  it('caps combined Spire shields and bypasses them for impacts and collapses', () => {
    fixtureUpgrade({ effects: [
      { kind: 'modifier', target: { structures: true }, stat: 'damage_taken', add: -0.4 },
      { kind: 'modifier', target: { segment: 'surface' }, stat: 'damage_taken', add: -0.4 },
    ], reveal: { kind: 'modifier', stat: 'damage_taken' } });
    const g = game({ research: { ascentThrustersTime: 0.1, shieldCap: 0.5 }, depths: { defuseTime: 120 } });
    research(g);
    const s = g.sim;
    const segment = s.armies[BLUE]!.spire.surface;
    expect(s.stat(segment).damage_taken).toBe(0.5);
    expect(s.stat(s.armies[BLUE]!.spire.orbit).damage_taken).toBe(0.6);
    const hp = segment.hp;
    s.damage(segment, 100, RED);
    expect(segment.hp).toBe(hp - 50);
    expect(s.armies[RED]!.group.seenResearch[BLUE]!.size).toBe(0);
    const surface = s.vis[PLANE_INDEX.surface]!;
    surface[cellOfEnt(segment, 48)] = surface[cellOfEnt(segment, 48)]! | s.armies[RED]!.group.bit;
    s.damage(segment, 100, RED);
    expect(s.armies[RED]!.group.seenResearch[BLUE]!.has('ascent_thrusters')).toBe(true);
    s.damage(segment, 100, RED, true);
    expect(segment.hp).toBe(hp - 200);
    const asteroid = s.add('asteroid', RED, 'sky', segment.x, segment.y);
    asteroid.state = 'falling';
    asteroid.fx = asteroid.ix = segment.x;
    asteroid.fy = asteroid.iy = segment.y;
    asteroid.impactTick = s.tick + 1;
    g.step();
    // Shields are bypassed; the Spire impact multiplier still applies.
    expect(segment.hp).toBe(hp - 200 - s.econ.impactDamage * s.econ.spireImpactMultiplier);
    const beforeCollapse = segment.hp;
    s.plantCharge(RED, cellOfEnt(segment, 48));
    for (let tick = 0; tick <= s.econ.undermineTicks; tick++) g.step();
    expect(segment.hp).toBe(beforeCollapse - s.econ.collapseDamage);
  });
});
