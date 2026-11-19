import { describe, expect, it } from 'vitest';
import { validateTelemetryRows } from 'playerthree/results';
import { validate } from 'playerthree/schema';
import { createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_DEFAULTS, BOT_KNOBS, CELL, PLANES, STATS, TICK_RATE, botDescriptor, observerSchema, resolveBotOptions, type ArmyId } from '../src/rules/contract.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';
import { createMetrics, eventDefinitions, metricDefinitions } from '../src/metrics/metrics.ts';

const fixture = () => createGame({ seed: 91, options: { map: { params: { homeLodes: 0, contestedZones: [] } } } });

describe('observer-only projection', () => {
  it('contains entities unseen by either side, real underground terrain, and both public economies', () => {
    const game = fixture();
    const middle = game.sim.size / 2;
    const hidden = game.sim.add('sapper', 1, 'depths', middle, middle);
    for (const plane of game.sim.vis) plane.fill(0);
    const neutral = game.sim.add('asteroid', NEUTRAL, 'orbit', middle, middle);
    // In a team's view iff the team has a name for it and that name is among the view's entities.
    const shows = (team: ArmyId, simId: number): boolean => {
      const entities = game.view(team).entities;
      const alias = game.sim.aliasOf(game.sim.armyIndex(team), simId);
      return alias !== 0 && entities.some((e) => e.id === `e_${alias}`);
    };
    expect(shows('nw', hidden.id)).toBe(false);
    expect(shows('nw', neutral.id)).toBe(false);
    expect(shows('se', neutral.id)).toBe(false);
    const before = game.stateHash();
    const snapshot = game.observerView();
    expect(validate(observerSchema, snapshot).ok).toBe(true);
    expect(snapshot.world.entities.some((e) => e.id === `e_${hidden.id}`)).toBe(true);
    expect(snapshot.world.entities.some((e) => e.id === `e_${neutral.id}`)).toBe(true);
    expect(snapshot.world.depths).toEqual(Array.from(game.sim.cells));
    expect(snapshot.terrain.ore).toEqual(Array.from(game.sim.ore));
    expect(snapshot.sides.map((side) => side.army)).toEqual(['nw', 'se']);
    expect(game.stateHash()).toBe(before);
    expect(shows('nw', hidden.id)).toBe(false);
  });

  it('never exposes mandates, policy state, private orders or mutable sim references', () => {
    const game = fixture();
    const unit = game.sim.add('trooper', 0, 'surface', 12, 12);
    unit.order = { k: 'move', x: 25, y: 26, fight: false, speed: 0 };
    const snapshot = game.observerView();
    expect(snapshot.world.seats).toEqual([]);
    const entity = snapshot.world.entities.find((e) => e.id === `e_${unit.id}`)!;
    expect(entity).not.toHaveProperty('tx');
    expect(entity).not.toHaveProperty('order');
    expect(snapshot).not.toHaveProperty('rng');
    expect(snapshot).not.toHaveProperty('policy');
    snapshot.world.depths[0] = CELL.magma;
    snapshot.terrain.ore[0] = 255;
    snapshot.world.entities[0]!.hp = 0;
    expect(game.sim.ore[0]).not.toBe(255);
    expect(game.sim.ents[0]!.hp).toBeGreaterThan(0);
    expect(validate(observerSchema, { ...snapshot, privateState: {} }).ok).toBe(false);
    expect(validate(observerSchema, { ...snapshot, world: { ...snapshot.world, seats: game.view('nw').seats } }).ok).toBe(false);
  });

  it('moves current army replacement value between planes without changing production attribution', () => {
    const game = fixture();
    const unit = game.sim.add('trooper', 0, 'surface', 12, 12);
    const before = game.observerView().sides[0]!.forces;
    unit.plane = 'depths';
    const after = game.observerView().sides[0]!.forces;
    expect(after.find((row) => row.plane === 'surface')!.alloy).toBe(before.find((row) => row.plane === 'surface')!.alloy - game.sim.stats.trooper.alloy);
    expect(after.find((row) => row.plane === 'depths')!.energy).toBe(before.find((row) => row.plane === 'depths')!.energy + game.sim.stats.trooper.energy);
  });

  it('carries every army\'s final placement once its outcome is final, never before', () => {
    const game = fixture();
    expect(game.observerView().sides.map((side) => side.rank)).toEqual([undefined, undefined]);
    game.forfeit('se');
    game.step();
    const snapshot = game.observerView();
    expect(validate(observerSchema, snapshot).ok).toBe(true);
    expect(snapshot.sides.map((side) => [side.army, side.rank])).toEqual([['nw', 1], ['se', 2]]);
  });
});

describe('native raw accounting', () => {
  it('does not alter authoritative state or random evolution', () => {
    const recorded = fixture();
    const control = fixture();
    const recorder = createMetrics(recorded);
    for (let tick = 0; tick < 2 * TICK_RATE; tick++) {
      recorded.step(); control.step(); recorder.collect();
      expect(recorded.stateHash()).toBe(control.stateHash());
    }
    recorder.finish();
  });

  it('declares every raw and terminal metric and safe event', () => {
    const game = fixture();
    const recorder = createMetrics(game);
    game.sim.emit([0], 'constructed', 'surface', 12, 12, 'turret', 0, { owner: 'sky' });
    for (let tick = 0; tick < TICK_RATE; tick++) { game.step(); recorder.collect(); }
    const summary = recorder.finish();
    const rows = recorder.rows('match_descriptors');
    for (const row of rows.metrics!) expect(metricDefinitions.some((definition) => definition.scope === row.scope && definition.metric === row.metric && definition.unit === row.unit)).toBe(true);
    for (const key of Object.keys(summary.match)) expect(metricDefinitions.some((definition) => definition.scope === 'match' && definition.metric === key)).toBe(true);
    for (const side of Object.values(summary.sides)) for (const key of Object.keys(side)) expect(metricDefinitions.some((definition) => definition.scope === 'side' && definition.metric === key)).toBe(true);
    for (const event of rows.events!) expect(eventDefinitions.some((definition) => definition.kind === event.kind)).toBe(true);
    expect(rows.metrics!.findLast((row) => row.team === 'nw' && row.role === 'sky' && row.metric === 'production.structures')!.value).toBe(1);
  });

  it('retains the firing plane after a projectile outlives its source', () => {
    const game = fixture();
    const recorder = createMetrics(game);
    const middle = game.sim.size / 2;
    const bomber = game.sim.add('bomber', 0, 'sky', middle, middle);
    const victim = game.sim.add('trooper', 1, 'surface', middle, middle);
    victim.hp = 1;
    game.sim.scan(0, middle, middle);
    for (let tick = 0; tick < 2 * TICK_RATE && !game.sim.projectiles.length; tick++) { game.step(); recorder.collect(); }
    expect(game.sim.projectiles.some((projectile) => projectile.source === 'bomber' && projectile.sourcePlane === 'sky')).toBe(true);
    bomber.hp = 0;
    for (let tick = 0; tick < 2 * TICK_RATE && !victim.dead; tick++) { game.step(); recorder.collect(); }
    const rows = recorder.rows('match_projectile');
    expect(rows.causes!.find((row) => row.victimTeam === 'se' && row.victimKind === 'trooper')).toMatchObject({ attackerTeam: 'nw', attackerRole: 'sky', attackerKind: 'bomber', victimRole: 'surface' });
    recorder.finish();
  });

  it('retains every recorded event despite player-window eviction and remains clone-safe', () => {
    const game = fixture();
    const recorder = createMetrics(game);
    for (let i = 0; i < 2101; i++) game.sim.emit([0, 1], 'constructed', 'surface', 12, 12, 'turret', 0);
    expect(game.sim.armies[0]!.events.length).toBeLessThan(2101);
    expect(() => game.clone()).not.toThrow();
    recorder.collect();
    const rows = recorder.rows('match_events');
    expect(rows.events!.filter((event) => event.kind === 'constructed')).toHaveLength(2101);
    expect(new Set(rows.events!.map((event) => event.sequence)).size).toBe(rows.events!.length);
    recorder.finish();
  });

  it('samples shared economy once, keeps exact gross flows and seat spend/refund separate', () => {
    const game = fixture();
    const recorder = createMetrics(game);
    const initial = game.sim.armies[0]!.alloy;
    game.sim.queueAdd(0, 'surface', 'trooper', {});
    game.step(); recorder.collect();
    game.sim.queueCancel(0, 'sky', 0);
    for (let tick = 1; tick < TICK_RATE; tick++) { game.step(); recorder.collect(); }
    recorder.finish();
    const rows = recorder.rows('match_1');
    const metrics = rows.metrics!;
    const side = (key: string) => metrics.findLast((row) => row.team === 'nw' && row.role === null && row.metric === key)!.value;
    expect(side('economy.stock.alloy')).toBeCloseTo(initial + side('economy.income.alloy') - side('economy.spend.alloy') + side('economy.refund.alloy'));
    expect(side('economy.spend.alloy')).toBe(game.sim.stats.trooper.alloy);
    expect(side('economy.refund.alloy')).toBe(game.sim.stats.trooper.alloy * game.sim.econ.queueRefund);
    expect(metrics.filter((row) => row.tick === TICK_RATE && row.team === 'nw' && row.metric === 'economy.income.alloy')).toHaveLength(1);
    expect(metrics.findLast((row) => row.team === 'nw' && row.role === 'surface' && row.metric === 'economy.attributed.spend.alloy')!.value).toBe(game.sim.stats.trooper.alloy);
    expect(metrics.findLast((row) => row.team === 'nw' && row.role === 'sky' && row.metric === 'economy.attributed.refund.alloy')!.value).toBeGreaterThan(0);
    expect(recorder.rows('match_1').metrics).toEqual([]);
  });

  it('records friendly, cross-plane, environmental and unknown deaths exactly once', () => {
    const game = fixture();
    const recorder = createMetrics(game);
    const victims = ['nw', 'se', 'se', 'se'].map((team, index) => game.sim.add('trooper', slotOfArmyId(team as ArmyId, 2), 'surface', 20 + index, 20));
    game.sim.damage(victims[0]!, 100000, 0, true, 'tank', 'surface');
    game.sim.damage(victims[1]!, 100000, 0, true, 'bomber', 'sky');
    game.sim.damage(victims[2]!, 100000, NEUTRAL, true, 'storm');
    victims[3]!.hp = 0;
    game.step(); recorder.collect(); recorder.collect();
    const rows = recorder.rows('match_2');
    expect(rows.causes).toHaveLength(4);
    expect(rows.causes!.find((row) => row.cause === 'tank')).toMatchObject({ victimTeam: 'nw', attackerTeam: 'nw', attackerRole: 'surface' });
    expect(rows.causes!.find((row) => row.cause === 'bomber')).toMatchObject({ victimRole: 'surface', attackerRole: 'sky', attackerKind: 'bomber' });
    expect(rows.causes!.find((row) => row.cause === 'storm')).toMatchObject({ attackerTeam: null, attackerRole: null, attackerKind: null });
    expect(rows.causes!.find((row) => row.cause === 'unknown')).toBeDefined();
    expect(rows.causes!.reduce((sum, row) => sum + row.alloyValue, 0)).toBe(4 * game.sim.stats.trooper.alloy);
  });

  it('declares the kill cause and metrics of an army eliminated while a four-army match goes on', () => {
    const game = createGame({ seed: 5, options: { map: { name: 'four_corners' } } });
    const recorder = createMetrics(game);
    const ne = game.sim.armyIndex('ne');
    const segment = game.sim.armies[ne]!.spire.surface;
    game.sim.damage(segment, segment.hp + 1, game.sim.armyIndex('nw'), true, 'tank', 'surface');
    for (let tick = 0; tick < TICK_RATE; tick++) { game.step(); recorder.collect(); }
    expect(game.sim.over).toBe(false);
    const telemetry = { sampleEveryTicks: TICK_RATE, includeCommentary: false, metricDefinitions, eventDefinitions };
    const rows = recorder.rows('match_elimination');
    expect(rows.events!.filter((row) => row.kind === 'kill' && row.team === 'ne' && row.data['cause'] === 'eliminated').length).toBeGreaterThan(0);
    // The bench's own gate: an undeclared cause or metric fails the whole series (the S48 veteran FFA mirror did).
    expect(() => validateTelemetryRows(rows, telemetry)).not.toThrow();
    const summary = recorder.finish();
    expect(summary.match['environmental.eliminated']).toBeGreaterThan(0);
    for (const key of Object.keys(summary.match)) expect(metricDefinitions.some((definition) => definition.scope === 'match' && definition.metric === key), key).toBe(true);
    expect(() => validateTelemetryRows(recorder.rows('match_elimination'), telemetry)).not.toThrow();
  });

  it.each(['nw', 'se'] as const)('%s: declares the kill cause and metric of a dismantled own structure', (team) => {
    const game = fixture();
    const recorder = createMetrics(game);
    const army = slotOfArmyId(team, 2), home = game.sim.spireAt[army]!;
    const turret = game.sim.add('turret', army, 'surface', home.x + (team === 'nw' ? 6 : -6), home.y);
    expect(turret.built).toBe(true);
    expect(game.apply({ team, role: 'surface' }, { kind: 'dismantle', structure: game.entityId(team, turret.id) })).toEqual({ ok: true });
    for (let tick = 0; tick < TICK_RATE; tick++) { game.step(); recorder.collect(); }
    const telemetry = { sampleEveryTicks: TICK_RATE, includeCommentary: false, metricDefinitions, eventDefinitions };
    const rows = recorder.rows('match_dismantle');
    expect(rows.events!.filter((row) => row.kind === 'kill' && row.team === team && row.data['cause'] === 'dismantle')).toHaveLength(1);
    expect(() => validateTelemetryRows(rows, telemetry)).not.toThrow();
    const summary = recorder.finish();
    expect(summary.match['environmental.dismantle']).toBe(1);
    for (const key of Object.keys(summary.match)) expect(metricDefinitions.some((definition) => definition.scope === 'match' && definition.metric === key), key).toBe(true);
    expect(() => validateTelemetryRows(recorder.rows('match_dismantle'), telemetry)).not.toThrow();
  });

  it('keeps host intent attempts and rejection codes without unvalidated input', () => {
    const game = fixture();
    const recorder = createMetrics(game);
    recorder.intent({ team: 'nw', role: 'orbit', source: 'bot', code: 'ok', accepted: true });
    recorder.intent({ team: 'nw', role: 'orbit', source: 'bot', code: 'game:cannot_afford', accepted: false });
    recorder.intent({ team: 'se', role: 'surface', source: 'agent', code: 'schema:unknown_field', accepted: false });
    const rows = recorder.rows('match_3');
    expect(rows.intents!.reduce((sum, row) => sum + row.submitted, 0)).toBe(3);
    expect(rows.events!.filter((row) => row.kind === 'intent_ack')).toHaveLength(3);
    expect(rows.events!.every((row) => Object.keys(row.data).every((key) => ['source', 'code', 'accepted'].includes(key)))).toBe(true);
    expect(rows.metrics!.some((row) => row.metric === 'commandApm')).toBe(false);
  });
});

describe('deterministic bot knobs', () => {
  it('publishes tier defaults and rejects unknown, non-finite and out-of-range options', () => {
    expect(resolveBotOptions('standard')).toEqual(BOT_DEFAULTS.standard);
    expect(botDescriptor('idle').knobs).toEqual({});
    expect(BOT_KNOBS.aggression).toMatchObject({ min: 0, max: 1, step: 0.05 });
    for (const raw of [{ aggression: 2 }, { economyReserve: -0.1 }, { aggression: NaN }, { cheat: true }]) expect(() => resolveBotOptions('standard', raw)).toThrow();
  });

  it('uses reserve in actual optional production decisions', () => {
    const game = fixture();
    const seat = { team: 'nw', role: 'orbit' } as const;
    const entry = game.sim.queueAdd(0, 'orbit', 'lancer', {});
    entry.started = true; entry.status = 'building';
    const obs = game.observe(seat, 0);
    obs.res.alloy = obs.res.freeAlloy = STATS.solar.alloy + 1;
    obs.res.energy = obs.res.freeEnergy = 400;
    obs.entities = obs.entities.filter((entity) => entity.kind !== 'solar' && entity.kind !== 'tug');
    const low = createBot('nw', 'orbit', 'standard', { economyReserve: 0 });
    const high = createBot('nw', 'orbit', 'standard', { economyReserve: 1 });
    low.init?.(game.matchData(seat)); high.init?.(game.matchData(seat));
    expect(low.think(obs).some((intent) => intent.kind === 'queue_add')).toBe(true);
    expect(high.think(obs).some((intent) => intent.kind === 'queue_add')).toBe(false);
  });

  it('changes offensive commitment without RNG or altering world rules', () => {
    const game = fixture();
    const seat = { team: 'nw', role: 'surface' } as const;
    for (let i = 0; i < 10; i++) game.sim.add('trooper', 0, 'surface', 12 + i * 0.1, 12);
    const obs = game.observe(seat, 0);
    obs.lodes = []; obs.tremors = []; obs.oreCaches = [];
    const low = createBot('nw', 'surface', 'standard', { aggression: 0 });
    const high = createBot('nw', 'surface', 'standard', { aggression: 1 });
    const data = game.matchData(seat);
    low.init?.(data); high.init?.(data);
    const rules = game.stateHash();
    // Holding vantage posts around the front may cross the midline on generated terrain, and detachments take our own
    // forward posts with `attack` orders at any aggression: commitment means attacking or moving into the enemy's quarter.
    const quarter = (x: number | undefined): boolean => (x ?? 0) > game.sim.size * 3 / 4;
    const offensive = (intent: { kind: string; x?: number; target?: string }) => intent.kind === 'attack'
      ? quarter(obs.entities.find((e) => e.id === intent.target)?.x) : intent.kind === 'move' && quarter(intent.x);
    expect(high.think(obs).some(offensive)).toBe(true);
    expect(low.think(obs).some(offensive)).toBe(false);
    expect(game.stateHash()).toBe(rules);
    expect(PLANES).toHaveLength(4);
  });
});
