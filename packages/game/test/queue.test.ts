import { describe, expect, it, vi } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, PLANES, QUEUE_ITEMS, STATS, STRUCTURE_SPACING, SURFACE, eventSchema, footprintOverlap, surfaceSiteLevel, observationSchema, toTicks, type GameEvent, type MatchOptions, type Observation, type Plane, type ArmyId } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { applyIntent, type AgentCommandIntent } from '../src/agent/intents.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const queue = (g: AgentCommandGame, team: ArmyId = 'nw') => g.observe({ team, role: 'surface' }, 0).queue;
const status = (g: AgentCommandGame, team: ArmyId = 'nw') => queue(g, team).map((e) => `${e.id} ${e.item} ${e.status}${e.reason ? ` ${e.reason}` : ''}`);
const queueEvents = (g: AgentCommandGame, team: ArmyId = 'nw'): GameEvent[] => g.events({ team, role: 'surface' }, -1).filter((e) => e.kind.startsWith('queue_'));

/** Visible, buildable 2×2 sites: safe for both Shafts and turrets, with a complete spacing ring. */
function sites(g: AgentCommandGame, team: ArmyId, n: number): { x: number; y: number }[] {
  const s = g.sim;
  const out: { x: number; y: number }[] = [];
  const home = team === 'nw' ? { x: 12, y: 12 } : { x: s.size - 12, y: s.size - 12 };
  for (let r = 0; r < 8 && out.length < n; r++) {
    for (let dy = -r; dy <= r && out.length < n; dy++) {
      for (let dx = -r; dx <= r && out.length < n; dx++) {
        const x = Math.floor(home.x) + dx;
        const y = Math.floor(home.y) + dy;
        const cells = [y * s.size + x, y * s.size + x + 1, (y + 1) * s.size + x, (y + 1) * s.size + x + 1];
        if (x < 0 || y < 0 || x + 2 > s.size || y + 2 > s.size) continue;
        if (surfaceSiteLevel(s.terrain, s.size, x, y, 2, 2) < 0 || surfaceSiteLevel(s.terrain, s.size, x, y, 1, 1) < 0 ||
          s.buildSiteError(slotOfArmyId(team, 2), 'shaft', x + 1, y + 1) || s.buildSiteError(slotOfArmyId(team, 2), 'turret', x + 0.5, y + 0.5)) continue;
        const group = s.armies[slotOfArmyId(team, 2)]!.group;
        if (cells.some((c) => !(s.vis[1]![c]! & group.bit) || s.block[c] || s.cells[c] === CELL.bedrock ||
          (s.terrain[c] !== SURFACE.ground && s.terrain[c] !== SURFACE.high) || (s.lodes[s.lodeAt[c]!]?.known ?? 0) & group.bit)) continue;
        if (s.siteTaken(x + 1, y + 1, slotOfArmyId(team, 2), 'shaft')) continue;
        if (out.some((o) => footprintOverlap('shaft', x + 1, y + 1, 'shaft', o.x + 1, o.y + 1, STRUCTURE_SPACING))) continue;
        out.push({ x, y });
      }
    }
  }
  return out;
}

function rich(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 9, options });
  for (const team of (['nw', 'se'] as const)) {
    g.sim.armies[slotOfArmyId(team, 2)]!.alloy = 5000;
    g.sim.armies[slotOfArmyId(team, 2)]!.energy = 5000;
  }
  return g;
}

describe('team build queue: funding', () => {
  it.each(['nw', 'se'] as const)('%s: an unaffordable Orbit head cannot stall affordable Surface work', (team) => {
    const g = createGame({ seed: 9 });
    const army = slotOfArmyId(team, 2), t = g.sim.armies[army]!;
    t.alloy = STATS.trooper.alloy * 2;
    t.energy = 0;
    expect(act(g, team, 'orbit', { kind: 'queue_add', item: 'lancer' })).toEqual({ ok: true });
    expect(act(g, team, 'surface', { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
    g.sim.updateProduction();
    expect(status(g, team)).toEqual(['q_1 lancer waiting funds', 'q_2 trooper building']);
    expect(queue(g, team)[0]).toMatchObject({ heldAlloy: STATS.trooper.alloy, heldEnergy: 0, paid: false, next: true, progress: 0 });
    expect(queue(g, team)[0]!.eta).toBeUndefined();
    expect(queue(g, team)[1]).toMatchObject({ paid: true, next: false, heldAlloy: 0, heldEnergy: 0 });
    expect(queue(g, team)[1]!.eta).toBeGreaterThan(0);
    expect(t.alloy).toBe(STATS.trooper.alloy);
    expect(g.sim.available(army, 'alloy')).toBe(0);
  });

  it('funds each lane head and starts later entries idle stock pays in full, while paid producers build in parallel', () => {
    const g = rich();
    const [a, b] = sites(g, 'nw', 2);
    for (const [role, intent] of [
      ['depths', { kind: 'queue_add', item: 'digger', count: 2 }],
      ['surface', { kind: 'queue_add', item: 'trooper' }],
      ['sky', { kind: 'queue_add', item: 'interceptor' }],
      ['orbit', { kind: 'queue_add', item: 'solar' }],
      ['surface', { kind: 'queue_add', item: 'turret', ...a! }],
      ['surface', { kind: 'queue_add', item: 'shaft', ...b! }],
    ] as const) expect(act(g, 'nw', role, intent)).toEqual({ ok: true });
    g.step();
    expect(status(g)).toEqual([
      'q_1 digger building',
      'q_2 digger waiting producer',
      'q_3 trooper building',
      'q_4 interceptor building',
      'q_5 solar building',
      'q_6 turret building',
      'q_7 shaft building',
    ]);
    steps(g, 2);
    const sitesNow = queue(g).filter((e) => e.site).map((e) => g.sim.alive(g.sim.aliasTarget(BLUE, Number(e.site!.slice(2))))!);
    expect(sitesNow.map((e) => [e.kind, e.state])).toEqual([['turret', 'constructing'], ['shaft', 'constructing']]);
    // The segment carries its queued unit count, and the second digger follows the first.
    expect(g.sim.armies[BLUE]!.spire.depths.carry).toBe(2);
    steps(g, STATS.digger.build);
    expect(status(g)[0]).toBe('q_2 digger building');
    steps(g, Math.max(STATS.shaft.build, STATS.turret.build, STATS.digger.build) + 1);
    expect(queue(g)).toEqual([]);
    expect(sitesNow.every((e) => e.built)).toBe(true);
    const produced = g.events({ team: 'nw', role: 'depths' }, 0).filter((e) => e.kind === 'produced').map((e) => e.subject);
    expect(produced.sort()).toEqual(['digger', 'digger', 'interceptor', 'solar', 'trooper']);
  });

  it('blocked entries are skipped by funding and say why', () => {
    const g = rich();
    const [a] = sites(g, 'nw', 1);
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...a! })).toEqual({ ok: true });
    expect(act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'tug' })).toEqual({ ok: true });
    g.sim.block[a!.y * g.sim.size + a!.x] = 1; // the site turned into a hole before work reached it
    g.sim.armies[BLUE]!.spire.orbit.hp = 0;
    expect(act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'solar' })).toEqual({ ok: false, code: 'segment_destroyed' });
    expect(act(g, 'nw', 'depths', { kind: 'queue_add', item: 'digger' })).toEqual({ ok: true });
    g.step();
    expect(status(g)).toEqual(['q_1 turret blocked blocked', 'q_2 tug blocked segment_destroyed', 'q_3 digger building']);
    expect(queue(g)[0]!.eta).toBeUndefined();
  });

  it.each(['nw', 'se'] as const)('%s: an entry waiting on its busy producer does not hold back later work in its lane', (team) => {
    const g = rich(), army = slotOfArmyId(team, 2), t = g.sim.armies[army]!;
    const [a] = sites(g, team, 1);
    expect(act(g, team, 'surface', { kind: 'queue_add', item: 'tank', count: 2 })).toEqual({ ok: true });
    expect(act(g, team, 'surface', { kind: 'queue_add', item: 'turret', ...a! })).toEqual({ ok: true });
    steps(g, 2);
    expect(status(g, team)).toEqual(['q_1 tank building', 'q_2 tank waiting producer', 'q_3 turret building']);
    // Once the Spire segment frees up, the waiting tank is the lane's head again.
    steps(g, STATS.tank.build);
    expect(status(g, team)[0]).toBe('q_2 tank building');
    expect(t.queue.every(e => e.started)).toBe(true);
  });

  it.each(['nw', 'se'] as const)('%s: a head change moves the lane backing to its new head, never to other lanes', (team) => {
    const g = createGame({ seed: 9 }), s = g.sim, army = slotOfArmyId(team, 2), t = s.armies[army]!;
    t.alloy = 60; t.energy = 0;
    act(g, team, 'surface', { kind: 'queue_add', item: 'tank' });
    act(g, team, 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(army);
    expect(t.queue.map(e => e.heldAlloy)).toEqual([30, 30]);
    expect(act(g, team, 'surface', { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
    expect(act(g, team, 'surface', { kind: 'queue_move', entry: 'q_3', index: 0 })).toEqual({ ok: true });
    s.allocateQueue(army);
    expect(t.queue.map(e => [e.item, e.heldAlloy])).toEqual([['trooper', 30], ['tank', 0], ['lancer', 30]]);
  });

  it('returns only the surplus beyond a new head\'s full backing to the shared free bank', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = STATS.tank.alloy; t.energy = 0;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
    s.allocateQueue(BLUE);
    act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'lancer' });
    t.alloy += 30;
    s.allocateQueue(BLUE);
    expect(t.queue.map(e => e.heldAlloy)).toEqual([STATS.tank.alloy, 30]);
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'trooper', index: 0 });
    s.allocateQueue(BLUE);
    const surplus = STATS.tank.alloy - STATS.trooper.alloy;
    expect(t.queue.map(e => [e.item, e.heldAlloy])).toEqual([['trooper', STATS.trooper.alloy], ['tank', 0], ['lancer', 30 + surplus]]);
    expect(s.available(BLUE, 'alloy')).toBe(0);
  });

  it('counts viable workers once per allocation pass, not once per entry', () => {
    const g = rich(), s = g.sim;
    for (const [role, item] of [['depths', 'sapper'], ['surface', 'tank'], ['sky', 'bomber'], ['orbit', 'lancer']] as const)
      expect(act(g, 'nw', role, { kind: 'queue_add', item, count: 2 })).toEqual({ ok: true });
    const spy = vi.spyOn(s, 'viableWorkers');
    s.allocateQueue(BLUE);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    s.updateProduction();
    // One per army for its allocation pass and one for its start pass.
    expect(spy).toHaveBeenCalledTimes(2 * s.allArmies.length);
    spy.mockRestore();
  });
});

describe('team build queue: idle stock never waits behind a short head', () => {
  // The reported stall: Headframes / Solar Arrays sat at "needs funds" for minutes behind a lane head starved of the
  // other resource while the free bank held a surplus of theirs. Any army slot must start them on the next tick.
  for (const [label, options] of [['duel', {}], ['four armies', { map: { name: 'four_corners' } }]] as const) {
    it(`${label}: a later entry the free bank pays in full starts within one tick; the short head keeps its backing`, () => {
      const g = createGame({ seed: 9, options }), s = g.sim;
      for (const team of s.armyIds) {
        const t = s.armies[s.armyIds.indexOf(team)]!;
        t.alloy = 1000; t.energy = 0; t.upkeep = 0;
        for (const [role, item] of [['orbit', 'lancer'], ['orbit', 'solar'], ['surface', 'tank'], ['surface', 'trooper'], ['sky', 'interceptor'], ['sky', 'interceptor']] as const)
          expect(act(g, team, role, { kind: 'queue_add', item })).toEqual({ ok: true });
      }
      g.step();
      for (const team of s.armyIds) {
        const army = s.armyIds.indexOf(team), t = s.armies[army]!;
        expect(t.queue.map((e) => `${e.item} ${e.started ? 'paid' : `${e.status} ${e.reason}`}`), team).toEqual([
          // Each started entry took its Spire segment, so the energy-starved head now waits on it, still backed.
          'lancer waiting producer', 'solar paid', 'tank waiting producer', 'trooper paid',
          'interceptor waiting funds', 'interceptor waiting lane',
        ]);
        expect(t.queue.filter((e) => !e.started).map((e) => [e.heldAlloy, e.heldEnergy]), team).toEqual([[STATS.lancer.alloy, 0], [STATS.tank.alloy, 0], [STATS.interceptor.alloy, 0], [0, 0]]);
        // Paid from free stock only (the tick's Spire trickle aside), identically for every army.
        expect(t.alloy, team).toBe(s.armies[0]!.alloy);
        expect(Math.floor(t.alloy), team).toBe(1000 - STATS.solar.alloy - STATS.trooper.alloy);
        const view = queue(g, team).map((e) => [e.item, e.next, e.reason]);
        expect(view.slice(4), team).toEqual([['interceptor', true, 'funds'], ['interceptor', false, 'lane']]);
      }
    });
  }
});

describe('shared bank allocation and conservation', () => {
  it.each(['nw', 'se'] as const)('%s: a scan may use only its own Orbit earmark, never the Surface one', (team) => {
    const g = createGame({ seed: 9 }), s = g.sim, army = slotOfArmyId(team, 2), t = s.armies[army]!;
    t.alloy = 0; t.energy = 60;
    act(g, team, 'surface', { kind: 'queue_add', item: 'tank' });
    act(g, team, 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(army);
    expect(t.queue.map(e => e.heldEnergy)).toEqual([30, 30]);
    // Free 0 + own Orbit hold 30 < 50: the Surface tank's 30 is not the Orbit seat's to spend.
    expect(act(g, team, 'orbit', { kind: 'scan', x: 12, y: 12 })).toEqual({ ok: false, code: 'cannot_afford' });
    expect(t.energy).toBe(60);
    t.energy += s.econ.scanCost - 30;
    expect(act(g, team, 'orbit', { kind: 'scan', x: 12, y: 12 })).toEqual({ ok: true });
    // Free stock goes first, then the Orbit earmark; the tank's backing is untouched.
    expect(t.energy).toBe(30);
    expect(t.queue.map(e => e.heldEnergy)).toEqual([30, 0]);
    expect(s.available(army, 'energy')).toBe(0);
  });

  it.each(['nw', 'se'] as const)('%s: cheap Surface spam cannot drain an expensive Orbit commitment', (team) => {
    const g = createGame({ seed: 9 }), s = g.sim, army = slotOfArmyId(team, 2), t = s.armies[army]!;
    t.alloy = 0;
    t.energy = 1000;
    expect(act(g, team, 'surface', { kind: 'queue_add', item: 'trooper', count: 4 })).toEqual({ ok: true });
    expect(act(g, team, 'orbit', { kind: 'queue_add', item: 'lancer' })).toEqual({ ok: true });
    const lancer = t.queue.find(e => e.item === 'lancer')!;
    let injected = 0;
    for (let i = 0; i < STATS.lancer.alloy / 5 && !lancer.started; i++) {
      const saved = lancer.heldAlloy;
      t.alloy += 10;
      injected += 10;
      s.updateProduction();
      s.tick++;
      if (!lancer.started) expect(lancer.heldAlloy).toBeGreaterThanOrEqual(saved + 5);
      const paid = t.queue.reduce((sum, e) => sum + (e.started ? s.queueStats(e.item, e.producer).alloy : 0), 0);
      const held = t.queue.reduce((sum, e) => sum + e.heldAlloy, 0);
      expect(t.alloy + paid).toBeCloseTo(injected, 9);
      expect(held).toBeLessThanOrEqual(t.alloy);
      expect(s.available(army, 'alloy') + held).toBeCloseTo(t.alloy, 9);
    }
    expect(lancer.started).toBe(true);
    expect(t.queue.some(e => e.item === 'trooper' && e.started)).toBe(true);
    expect(t.queue.some(e => e.item === 'trooper' && !e.started && e.heldAlloy > 0)).toBe(true);
  });

  it('reuses idle shares immediately without banking a returning lane an entitlement', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 20; t.energy = 0;
    act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(BLUE);
    expect(t.queue[0]!.heldAlloy).toBe(20);
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'trooper' });
    t.alloy += 20;
    s.allocateQueue(BLUE);
    expect(t.queue.map(e => e.heldAlloy)).toEqual([30, 10]);
    expect(t.alloy).toBe(40);
  });

  it('never invents credits or a waiting ETA when both incomes are zero', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = t.energy = 0;
    for (const [role, item] of [['depths', 'sapper'], ['surface', 'tank'], ['sky', 'bomber'], ['orbit', 'lancer']] as const)
      expect(act(g, 'nw', role, { kind: 'queue_add', item })).toEqual({ ok: true });
    for (let i = 0; i < 120; i++) { s.updateProduction(); s.tick++; }
    expect(t.queue.every(e => !e.started && e.heldAlloy === 0 && e.heldEnergy === 0)).toBe(true);
    expect(queue(g).every(e => e.eta === undefined && !e.paid && e.next)).toBe(true);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).res).toMatchObject({
      alloy: 0, energy: 0, freeAlloy: 0, freeEnergy: 0, heldAlloy: 0, heldEnergy: 0, recoveryAlloy: 0, recoveryEnergy: 0,
    });
  });

  it('backs commitments with real stock and lets direct spending use only the unheld remainder and its own lane', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 40; t.energy = 0;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
    s.allocateQueue(BLUE);
    expect(t.queue[0]!.heldAlloy).toBe(40);
    expect(s.canSpend(BLUE, 1, 0)).toBe(false);
    expect(s.spend(BLUE, 1, 0, 'depths')).toBe(false);
    expect(t.alloy).toBe(40);
    t.alloy += 7;
    expect(s.spend(BLUE, 7, 0, 'depths')).toBe(true);
    expect(t.alloy).toBe(40);
    expect(t.queue[0]!.heldAlloy).toBe(40);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).res).toMatchObject({ alloy: 40, freeAlloy: 0, heldAlloy: 40 });
    // The Surface seat's own direct spends and guarded admissions may draw on the Surface earmark.
    expect(s.canSpend(BLUE, 41, 0, 'surface')).toBe(false);
    expect(s.queueAffordable(BLUE, 'surface', 'trooper', 0, 1)).toBe(true);
    expect(s.queueAffordable(BLUE, 'depths', 'digger', 0, 1)).toBe(false);
    expect(s.spend(BLUE, 10, 0, 'surface')).toBe(true);
    expect(t.alloy).toBe(30);
    expect(t.queue[0]!.heldAlloy).toBe(30);
    expect(s.available(BLUE, 'alloy')).toBe(0);
  });

  it('spends fully backed work after upkeep drains its reserve without charging a second buffer', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = STATS.tank.alloy;
    t.upkeep = s.econ.turretUpkeep;
    const reserve = t.upkeep * s.econ.queueUpkeepSeconds;
    expect(reserve).toBeGreaterThan(0);
    t.energy = STATS.tank.energy + reserve;
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' })).toEqual({ ok: true });
    s.allocateQueue(BLUE);
    const tank = t.queue[0]!;
    expect(tank.heldEnergy).toBe(STATS.tank.energy);
    expect(s.payUpkeep(BLUE, reserve)).toBe(true);
    expect(t.energy).toBe(STATS.tank.energy);
    expect(tank.heldEnergy).toBe(STATS.tank.energy);
    expect(s.available(BLUE, 'energy')).toBe(0);
    expect(s.available(BLUE, 'energy', tank)).toBe(STATS.tank.energy);
    s.updateProduction();
    expect(tank.started).toBe(true);
    expect(t.energy).toBe(0);
    expect(tank.heldEnergy).toBe(0);
  });

  it.each(['nw', 'se'] as const)('%s: upkeep draws on held energy in proportion before any structure goes unpowered', (team) => {
    const g = createGame({ seed: 9 }), s = g.sim, army = slotOfArmyId(team, 2), t = s.armies[army]!;
    t.alloy = 0; t.energy = 60;
    act(g, team, 'surface', { kind: 'queue_add', item: 'tank' });
    act(g, team, 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(army);
    expect(t.queue.map(e => e.heldEnergy)).toEqual([30, 30]);
    expect(s.payUpkeep(army, 20)).toBe(true);
    expect(t.energy).toBe(40);
    expect(t.queue.map(e => e.heldEnergy)).toEqual([20, 20]);
    expect(s.available(army, 'energy', undefined, true)).toBe(0);
    // Only a bank that cannot cover the tick leaves the grid dark, and then nothing is charged.
    expect(s.payUpkeep(army, 41)).toBe(false);
    expect(t.energy).toBe(40);
    expect(t.queue.map(e => e.heldEnergy)).toEqual([20, 20]);
    // Through the real economy step: income below upkeep keeps the army powered while the bank lasts.
    const turret = s.add('turret', army, 'surface', s.spireAt[army]!.x + (team === 'nw' ? 6 : -6), s.spireAt[army]!.y);
    expect(turret.built).toBe(true);
    g.step();
    expect(t.powered).toBe(true);
    expect(t.queue.reduce((sum, e) => sum + e.heldEnergy, 0)).toBeLessThanOrEqual(t.energy + 1e-9);
  });

  it('retains paused valid producer backing past grace without funding more, then releases it on destruction', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    const aerie = s.add('aerie', BLUE, 'sky', 12, 12);
    t.alloy = 20; t.energy = 0;
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'interceptor', producer: g.entityId('nw', aerie.id) })).toEqual({ ok: true });
    s.allocateQueue(BLUE);
    expect(t.queue[0]!.heldAlloy).toBe(20);
    t.powered = false;
    s.allocateQueue(BLUE);
    t.alloy += 20;
    s.tick += s.econ.queueBlockedGrace + 1;
    s.allocateQueue(BLUE);
    expect(t.queue[0]).toMatchObject({ status: 'blocked', reason: 'producer', heldAlloy: 20 });
    expect(s.available(BLUE, 'alloy')).toBe(20);
    t.powered = true;
    s.allocateQueue(BLUE);
    expect(t.queue[0]!.heldAlloy).toBe(40);
    s.damage(aerie, aerie.hp, RED);
    s.allocateQueue(BLUE);
    expect(t.queue[0]).toMatchObject({ status: 'blocked', reason: 'producer', heldAlloy: 0 });
    expect(s.available(BLUE, 'alloy')).toBe(40);
  });

  it('publishes fractional bank conservation without rounding away held or free resources', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 15.75; t.energy = 7.125; t.upkeep = 0.5;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
    act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(BLUE);
    const observed = g.observe({ team: 'nw', role: 'surface' }, 0).res;
    expect(observed.alloy).toBe(15.75);
    expect(observed.energy).toBe(7.125);
    expect(observed.freeAlloy + observed.heldAlloy).toBeCloseTo(observed.alloy, 12);
    expect(observed.freeEnergy + observed.heldEnergy + observed.upkeepHeld).toBeCloseTo(observed.energy, 12);
    expect(observed.heldAlloy).toBe(t.queue.reduce((sum, e) => sum + e.heldAlloy, 0));
    expect(g.view('nw').res).toEqual(observed);
  });

  it('releases an unpaid cancellation without refunding the same backing into the bank twice', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 40; t.energy = 0;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
    s.allocateQueue(BLUE);
    expect(s.available(BLUE, 'alloy')).toBe(0);
    expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_1' })).toEqual({ ok: true });
    expect(t.alloy).toBe(40);
    expect(s.available(BLUE, 'alloy')).toBe(40);
    expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_1' })).toEqual({ ok: false, code: 'invalid_target' });
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'trooper' });
    s.updateProduction();
    expect(t.queue[0]!.started).toBe(true);
    expect(t.alloy).toBe(0);
    expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_2' })).toEqual({ ok: true });
    expect(t.alloy).toBe(STATS.trooper.alloy * s.econ.queueRefund);
    expect(s.available(BLUE, 'alloy')).toBe(t.alloy);
  });

  it('releases missing-producer backing and funds another lane instead', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 40; t.energy = 0;
    act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(BLUE);
    expect(t.queue[0]!.heldAlloy).toBe(40);
    t.spire.orbit.hp = 0;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'trooper' });
    s.updateProduction();
    expect(queue(g)[0]).toMatchObject({ status: 'blocked', reason: 'segment_destroyed', heldAlloy: 0, paid: false });
    expect(queue(g)[1]).toMatchObject({ status: 'building', paid: true });
    expect(t.alloy).toBe(0);
  });

  it('counts paid pending units before starting another plane at the population cap', () => {
    const g = rich(), s = g.sim, t = s.armies[BLUE]!;
    t.pop = s.econ.popCap - 1;
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
    expect(act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'solar' })).toEqual({ ok: true });
    s.updateProduction();
    expect(t.queue.filter(e => e.started)).toHaveLength(1);
    expect(queue(g).find(e => !e.paid)).toMatchObject({ status: 'blocked', reason: 'pop_cap' });
    expect(t.pop).toBe(s.econ.popCap - 1);
    for (let i = 0; i < STATS.trooper.build; i++) s.updateProduction();
    expect(t.pop).toBe(s.econ.popCap);
    expect(t.queue).toHaveLength(1);
    expect(t.queue[0]).toMatchObject({ started: false, reason: 'pop_cap' });
  });

  it('rechecks shared structure capacity before paying a queued site', () => {
    const g = rich(), s = g.sim, t = s.armies[BLUE]!;
    const [a, b] = sites(g, 'nw', 2);
    t.structures = s.econ.structureCap - 2;
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...a! })).toEqual({ ok: true });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...b! })).toEqual({ ok: true });
    // Another real site takes the last spare capacity after both requests were admitted.
    s.build(BLUE, 'shaft', 20, 20, 'surface');
    s.updateProduction();
    s.updateProduction();
    expect(t.structures).toBe(s.econ.structureCap);
    expect(queue(g).filter(e => e.paid)).toHaveLength(1);
    expect(queue(g).find(e => !e.paid)).toMatchObject({ status: 'blocked', reason: 'structure_cap', heldAlloy: 0, heldEnergy: 0 });
  });

  it('counts paid bulkheads without a construction entity against later structure work', () => {
    const g = rich(), s = g.sim, t = s.armies[BLUE]!;
    const row = 20;
    for (let x = 12; x <= 22; x++) {
      const c = row * s.size + x;
      s.cells[c] = t.group.known[c] = CELL.tunnel;
      s.holes[c] = s.magma[c] = 0;
    }
    const digger = s.add('digger', BLUE, 'depths', 12.5, row + 0.5);
    digger.cell = row * s.size + 12;
    t.structures = s.econ.structureCap - 2;
    expect(act(g, 'nw', 'depths', { kind: 'queue_add', item: 'bulkhead', x: 21, y: row, digger: g.entityId('nw', digger.id) })).toEqual({ ok: true });
    const [site] = sites(g, 'nw', 1);
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...site! })).toEqual({ ok: true });
    s.build(BLUE, 'shaft', 25, 25, 'surface');
    s.updateProduction();
    expect(t.queue[0]).toMatchObject({ item: 'bulkhead', started: true, site: 0 });
    expect(t.structures).toBe(s.econ.structureCap - 1);
    expect(queue(g)[1]).toMatchObject({ item: 'turret', paid: false, status: 'blocked', reason: 'structure_cap' });
    s.allocateQueue(BLUE);
    expect(t.queue[1]!.heldAlloy).toBe(s.stats.turret.alloy);
    s.tick += s.econ.queueBlockedGrace + 1;
    s.allocateQueue(BLUE);
    expect(t.queue[1]!.heldAlloy).toBe(0);
  });
});

describe('team build queue: cancel and refunds', () => {
  it('refunds in full before an entry starts and rules.queue.refundStarted after', () => {
    for (const refundStarted of [0.5, 1, 0]) {
      const g = rich(refundStarted === 0.5 ? {} : { queue: { refundStarted } });
      const t = g.sim.armies[BLUE]!;
      t.energy = 0;
      act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
      g.step();
      expect(status(g)).toEqual(['q_1 tank waiting funds']);
      const before = { alloy: t.alloy, energy: t.energy };
      expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_1' })).toEqual({ ok: true });
      expect({ alloy: t.alloy, energy: t.energy }).toEqual(before); // never paid, nothing lost
      t.energy = 5000;
      act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
      g.step();
      expect(status(g)).toEqual(['q_2 tank building']);
      const paid = { alloy: t.alloy, energy: t.energy };
      expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_2' })).toEqual({ ok: true });
      expect(t.alloy).toBeCloseTo(paid.alloy + STATS.tank.alloy * refundStarted, 9);
      expect(t.energy).toBeCloseTo(paid.energy + STATS.tank.energy * refundStarted, 9);
      expect(queue(g)).toEqual([]);
      steps(g, STATS.tank.build + 1);
      expect(g.events({ team: 'nw', role: 'surface' }, 0).some((e) => e.kind === 'produced')).toBe(false);
    }
  });

  it('cancelling a started structure removes its site and frees the spot', () => {
    const g = rich();
    const t = g.sim.armies[BLUE]!;
    const [a] = sites(g, 'nw', 1);
    const structures = t.structures;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...a! });
    g.step();
    const site = g.sim.alive(g.sim.aliasTarget(BLUE, Number(queue(g)[0]!.site!.slice(2))))!;
    expect(site.kind).toBe('turret');
    expect(t.structures).toBe(structures + 1);
    expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_1' })).toEqual({ ok: true });
    expect(t.structures).toBe(structures);
    g.step();
    expect(g.sim.alive(site.id)).toBeUndefined();
    expect(g.events({ team: 'nw', role: 'surface' }, 0).some((e) => e.kind === 'structure_lost')).toBe(false);
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...a! })).toEqual({ ok: true });

    // A relay site: its island is free again.
    const island = g.sim.ents.find((e) => e.kind === 'island')!;
    g.sim.setSide(island, BLUE);
    act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: g.entityId('nw', island.id) });
    g.step();
    const relay = queue(g).find((e) => e.item === 'relay')!;
    expect(relay.status).toBe('building');
    expect(island.link).not.toBe(0);
    expect(act(g, 'nw', 'sky', { kind: 'queue_cancel', entry: relay.id })).toEqual({ ok: true });
    expect(island.link).toBe(0);
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: g.entityId('nw', island.id) })).toEqual({ ok: true });
  });
});

describe('team build queue: limits, reorder and events', () => {
  it('limits entries per seat and per team (match rules)', () => {
    const g = rich({ queue: { seatMax: 3, teamMax: 6 } });
    expect(g.matchData({ team: 'nw', role: 'surface' }).rules.queue).toMatchObject({ teamMax: 6, seatMax: 3, refundStarted: 0.5, laneSlots: 1 });
    g.sim.armies[BLUE]!.energy = 0; // keep everything waiting
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank', count: 3 })).toEqual({ ok: true });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' })).toEqual({ ok: false, code: 'queue_full' });
    expect(act(g, 'nw', 'depths', { kind: 'queue_add', item: 'sapper', count: 3 })).toEqual({ ok: false, code: 'queue_full' });
    expect(act(g, 'nw', 'depths', { kind: 'queue_add', item: 'sapper', count: 2 })).toEqual({ ok: false, code: 'queue_full' });
    expect(act(g, 'nw', 'depths', { kind: 'queue_add', item: 'sapper' })).toEqual({ ok: true });
    // An empty lane's protected slot cannot be consumed by Surface or Depths spam.
    expect(act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'tug' })).toEqual({ ok: true });
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'interceptor' })).toEqual({ ok: true });
    expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_2' })).toEqual({ ok: true });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank', index: 0 })).toEqual({ ok: true });
    expect(queue(g).map((e) => e.id)).toEqual(['q_7', 'q_1', 'q_3', 'q_4', 'q_5', 'q_6']);
    // The structure cap counts queued sites.
    const h = rich();
    h.sim.armies[BLUE]!.structures = h.sim.econ.structureCap - 1;
    const [a, b] = sites(h, 'nw', 2);
    expect(act(h, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...a! })).toEqual({ ok: true });
    expect(act(h, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...b! })).toEqual({ ok: false, code: 'queue_full' });
  });

  it('keeps owner edits role-local and reports global wire indices and provenance', () => {
    const g = rich();
    const t = g.sim.armies[BLUE]!;
    t.energy = 0;
    t.seats.surface.controller = 'human';
    t.seats.sky.controller = 'agent';
    t.seats.depths.controller = 'bot';
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
    g.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_add', item: 'sapper' }, { source: 'bot' });
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'flak' });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_move', entry: 'q_1', index: 39 }, { source: 'owner' })).toEqual({ ok: false, code: 'invalid_target' });
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_move', entry: 'q_1', index: 39 }, { source: 'owner' })).toEqual({ ok: true });
    expect(queue(g).filter(e => e.plane === 'surface').map(e => e.id)).toEqual(['q_3', 'q_1']);
    const moved = queue(g).findIndex(e => e.id === 'q_1');
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_move', entry: 'q_1', index: 0 }, { source: 'owner' })).toEqual({ ok: true });
    expect(queue(g).filter(e => e.plane === 'surface').map(e => e.id)).toEqual(['q_1', 'q_3']);
    expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_2' })).toEqual({ ok: false, code: 'invalid_target' });
    const cancelled = queue(g).findIndex(e => e.id === 'q_2');
    expect(act(g, 'nw', 'depths', { kind: 'queue_cancel', entry: 'q_2' })).toEqual({ ok: true });
    const evs = queueEvents(g);
    const brief = evs.map((e) => [e.kind, e.by, e.byCtl, e.owner, e.ownerCtl, e.entry, e.subject, e.index, e.from ?? null]);
    expect(brief).toEqual([
      ['queue_added', 'surface', 'human', 'surface', 'human', 'q_1', 'tank', 0, null],
      ['queue_added', 'depths', 'bot', 'depths', 'bot', 'q_2', 'sapper', 1, null],
      ['queue_added', 'surface', 'human', 'surface', 'human', 'q_3', 'flak', 2, null],
      ['queue_moved', 'surface', 'human', 'surface', 'human', 'q_1', 'tank', moved, 0],
      ['queue_moved', 'surface', 'human', 'surface', 'human', 'q_1', 'tank', 0, moved],
      ['queue_cancelled', 'depths', 'human', 'depths', 'bot', 'q_2', 'sapper', cancelled, null],
    ]);
    for (const e of evs) expect(validate(eventSchema, e).ok).toBe(true);
    expect(queueEvents(g, 'se')).toEqual([]);
    expect(validate(observationSchema, g.observe({ team: 'nw', role: 'sky' }, 0)).ok).toBe(true);
    // The requester's controller is the one it had when it asked.
    t.seats.surface.controller = 'agent';
    expect(queue(g).find((e) => e.id === 'q_1')!.byCtl).toBe('human');
  });
});

describe('team build queue: authenticated seat authority', () => {
  for (const source of ['owner', 'agent', 'policy', 'bot', 'fallback'] as const) {
    it(`${source} rejects every other plane's production without changing queue or funds`, () => {
      const g = rich();
      const army = g.sim.armies[BLUE]!;
      const before = { alloy: army.alloy, energy: army.energy, seq: army.queueSeq };
      for (const item of QUEUE_ITEMS) {
        const planes = item === 'rebuild' ? PLANES : [g.sim.queueStats(item).plane];
        for (const plane of planes) for (const role of PLANES) {
          if (role === plane) continue;
          expect(g.apply({ team: 'nw', role }, {
            kind: 'queue_add', item, ...(item === 'rebuild' ? { plane } : {}),
          }, { source })).toEqual({ ok: false, code: 'wrong_plane' });
        }
      }
      expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'research', upgrade: 'drill_bits' }, { source })).toEqual({ ok: false, code: 'wrong_plane' });
      expect(army.queue).toEqual([]);
      expect({ alloy: army.alloy, energy: army.energy, seq: army.queueSeq }).toEqual(before);
      expect(queueEvents(g)).toEqual([]);
    });

    it(`${source} adds and manages production through each authorized role`, () => {
      const g = rich();
      for (const [role, item] of [['depths', 'digger'], ['surface', 'tank'], ['sky', 'interceptor'], ['orbit', 'solar']] as const) {
        const seat = { team: 'nw', role } as const;
        expect(g.apply(seat, { kind: 'queue_add', item }, { source })).toEqual({ ok: true });
        const entry = queue(g).at(-1)!.id;
        expect(g.apply(seat, { kind: 'queue_move', entry, index: 0 }, { source })).toEqual({ ok: true });
        expect(g.apply(seat, { kind: 'queue_cancel', entry }, { source })).toEqual({ ok: true });
      }
      expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'turret', ...sites(g, 'nw', 1)[0]! }, { source })).toEqual({ ok: true });
      expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'research', upgrade: 'drill_bits' }, { source })).toEqual({ ok: true });
      g.sim.armies[BLUE]!.spire.orbit.hp = 0;
      expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'queue_add', item: 'rebuild' }, { source })).toEqual({ ok: true });
    });

    it(`${source} respects authenticated output roles and non-owner provenance protection`, () => {
      const g = rich();
      const army = g.sim.armies[BLUE]!;
      // Matching request provenance never grants access to another output role.
      g.sim.queueAdd(BLUE, 'depths', 'tank', {}, undefined, source);
      g.sim.queueAdd(BLUE, 'surface', 'tank', {}, undefined, source);
      if (source !== 'owner') {
        g.sim.queueAdd(BLUE, 'surface', 'digger', {}, undefined, source);
        g.sim.queueAdd(BLUE, 'depths', 'digger', {}, undefined, 'owner');
      }
      const before = { queue: structuredClone(army.queue), alloy: army.alloy, energy: army.energy };
      const events = queueEvents(g);
      for (const entry of queue(g)) {
        expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_cancel', entry: entry.id }, { source })).toEqual({ ok: false, code: 'invalid_target' });
        expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_move', entry: entry.id, index: 0 }, { source })).toEqual({ ok: false, code: 'invalid_target' });
      }
      expect({ queue: army.queue, alloy: army.alloy, energy: army.energy }).toEqual(before);
      expect(queueEvents(g)).toEqual(events);
    });

    it(`${source} is fenced by explicit entries only inside its own lane`, () => {
      const g = rich();
      g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'tank' });
      const seat = { team: 'nw', role: 'depths' } as const;
      expect(g.apply(seat, { kind: 'queue_add', item: 'sapper', index: 0 }, { source })).toEqual({ ok: true });
      expect(queue(g).map(e => e.item)).toEqual(['sapper', 'tank']);
      expect(g.apply(seat, { kind: 'queue_add', item: 'warden', index: 0 }, { source: 'owner' })).toEqual({ ok: true });
      expect(g.apply(seat, { kind: 'queue_move', entry: 'q_2', index: 0 }, { source })).toEqual({ ok: true });
      expect(queue(g).filter(e => e.plane === 'depths').map(e => e.item))
        .toEqual(source === 'owner' ? ['sapper', 'warden'] : ['warden', 'sapper']);
      expect(g.apply(seat, { kind: 'queue_move', entry: 'q_2', index: 0 }, { source: 'owner' })).toEqual({ ok: true });
      expect(queue(g).filter(e => e.plane === 'depths').map(e => e.item)).toEqual(['sapper', 'warden']);
      expect(g.apply(seat, { kind: 'queue_cancel', entry: 'q_2' }, { source }))
        .toEqual(source === 'owner' ? { ok: true } : { ok: false, code: 'invalid_target' });
    });

    it(`${source} authorizes output planes rather than alternate producer locations`, () => {
      const g = rich();
      const army = g.sim.armies[BLUE]!;
      const shaft = g.sim.add('shaft', BLUE, 'surface', 12, 12);
      const headframe = g.sim.add('headframe', BLUE, 'surface', 15, 15);
      const aerie = g.sim.add('aerie', BLUE, 'sky', 12, 12);
      army.spire.depths.hp = army.spire.sky.hp = 0;
      const digger = { kind: 'queue_add', item: 'digger', producer: g.entityId('nw', shaft.id) } as const;
      expect(g.apply({ team: 'nw', role: 'surface' }, digger, { source })).toEqual({ ok: false, code: 'wrong_plane' });
      expect(g.apply({ team: 'nw', role: 'depths' }, digger, { source })).toEqual({ ok: true });
      // Headframes mine lodes; unlike Shafts, they are not valid digger producers.
      expect(g.apply({ team: 'nw', role: 'depths' }, { ...digger, producer: g.entityId('nw', headframe.id) }, { source })).toEqual({ ok: false, code: 'invalid_target' });
      const interceptor = { kind: 'queue_add', item: 'interceptor', producer: g.entityId('nw', aerie.id) } as const;
      expect(g.apply({ team: 'nw', role: 'orbit' }, interceptor, { source })).toEqual({ ok: false, code: 'wrong_plane' });
      expect(g.apply({ team: 'nw', role: 'sky' }, interceptor, { source })).toEqual({ ok: true });
      expect(queue(g).map(e => [e.item, e.plane, e.by])).toEqual([['digger', 'depths', 'depths'], ['interceptor', 'sky', 'sky']]);
    });
  }

  it('requires owners to send cross-plane production and rebuilds through the output role', () => {
    const g = rich();
    const seat = { team: 'nw', role: 'depths' } as const;
    expect(g.apply(seat, { kind: 'queue_add', item: 'tank' }, { source: 'owner' })).toEqual({ ok: false, code: 'wrong_plane' });
    expect(g.apply(seat, { kind: 'queue_add', item: 'turret', ...sites(g, 'nw', 1)[0]! }, { source: 'owner' })).toEqual({ ok: false, code: 'wrong_plane' });
    g.sim.armies[BLUE]!.spire.sky.hp = 0;
    expect(g.apply(seat, { kind: 'queue_add', item: 'rebuild', plane: 'sky' }, { source: 'owner' })).toEqual({ ok: false, code: 'wrong_plane' });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'rebuild', plane: 'sky' }, { source: 'owner' })).toEqual({ ok: true });
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'research', upgrade: 'drill_bits' }, { source: 'owner' })).toEqual({ ok: false, code: 'wrong_plane' });
  });

  it('does not let separate human role owners reclaim each other\'s backing', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 60; t.energy = 0;
    t.seats.surface.controller = t.seats.orbit.controller = 'human';
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
    act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(BLUE);
    expect(t.queue.map(e => e.heldAlloy)).toEqual([30, 30]);
    expect(applyIntent(s, BLUE, 'surface', { kind: 'queue_priority', entry: 'q_2' }, 'owner')).toEqual({ ok: false, code: 'invalid_target' });
    expect(applyIntent(s, BLUE, 'surface', { kind: 'queue_priority', entry: 'q_1' }, 'owner')).toEqual({ ok: true });
    expect(t.queue.map(e => e.heldAlloy)).toEqual([30, 30]);
    expect(t.alloy).toBe(60);
    expect(queue(g).map(e => e.by)).toEqual(['surface', 'orbit']);
  });

  it('allows a solo owner a one-time transfer only from its trusted currently owned roles', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 60; t.energy = 0;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'tank' });
    act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(BLUE);
    const owned = ['surface', 'orbit'] as const;
    expect(applyIntent(s, BLUE, 'surface', { kind: 'queue_priority', entry: 'q_1' }, 'agent', owned).ok).toBe(false);
    expect(t.queue.map(e => e.heldAlloy)).toEqual([30, 30]);
    expect(applyIntent(s, BLUE, 'surface', { kind: 'queue_priority', entry: 'q_1' }, 'owner', owned)).toEqual({ ok: true });
    expect(t.queue.map(e => e.heldAlloy)).toEqual([60, 0]);
    expect(t.alloy).toBe(60);
    // Priority is not stored: subsequent income resumes equal-share allocation.
    t.alloy += 20;
    s.allocateQueue(BLUE);
    expect(t.queue.map(e => e.heldAlloy)).toEqual([70, 10]);
    expect(applyIntent(s, BLUE, 'orbit', { kind: 'queue_priority', entry: 'q_2' }, 'owner', ['orbit'])).toEqual({ ok: true });
    expect(t.queue.find(e => e.item === 'tank')!.heldAlloy).toBe(70);
    expect(t.queue.find(e => e.item === 'lancer')!.heldAlloy).toBe(10);
    expect(s.available(BLUE, 'alloy')).toBe(0);
  });

  it('transfers only a priority target shortfall and preserves excess backing in its other owned lane', () => {
    const g = createGame({ seed: 9 }), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = 60; t.energy = 0;
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'trooper' });
    act(g, 'nw', 'orbit', { kind: 'queue_add', item: 'lancer' });
    s.allocateQueue(BLUE);
    expect(t.queue.map(e => e.heldAlloy)).toEqual([30, 30]);
    expect(applyIntent(s, BLUE, 'surface', { kind: 'queue_priority', entry: 'q_1' }, 'owner', ['surface', 'orbit'])).toEqual({ ok: true });
    expect(t.queue.map(e => e.heldAlloy)).toEqual([40, 20]);
    expect(t.alloy).toBe(60);
    expect(s.available(BLUE, 'alloy')).toBe(0);
    s.updateProduction();
    expect(t.alloy).toBe(20);
    expect(t.queue.find(e => e.item === 'lancer')!.heldAlloy).toBe(20);
  });

  it.each(['policy', 'bot', 'fallback'] as const)('%s priority never crosses a rebuild or, while workers are short, a replacement digger', (source) => {
    const g = rich(), s = g.sim, t = s.armies[BLUE]!;
    t.alloy = t.energy = 0;
    for (const e of s.ents) if (e.side === BLUE && e.kind === 'digger') s.damage(e, e.hp, RED);
    expect(s.viableWorkers(BLUE)).toBeLessThan(s.econ.queueRecoveryWorkers);
    const depths = { team: 'nw', role: 'depths' } as const;
    expect(g.apply(depths, { kind: 'queue_add', item: 'digger' }, { source })).toEqual({ ok: true });
    expect(g.apply(depths, { kind: 'queue_add', item: 'sapper', index: 0 }, { source })).toEqual({ ok: true });
    expect(t.queue.filter(e => e.plane === 'depths').map(e => e.item)).toEqual(['digger', 'sapper']);
    const aerie = s.add('aerie', BLUE, 'sky', 12, 12);
    t.spire.sky.hp = 0;
    const sky = { team: 'nw', role: 'sky' } as const;
    expect(g.apply(sky, { kind: 'queue_add', item: 'rebuild' }, { source })).toEqual({ ok: true });
    expect(g.apply(sky, { kind: 'queue_add', item: 'interceptor', producer: g.entityId('nw', aerie.id), index: 0 }, { source })).toEqual({ ok: true });
    expect(t.queue.filter(e => e.plane === 'sky').map(e => e.item)).toEqual(['rebuild', 'interceptor']);
  });
});

describe('team build queue: determinism and bots', () => {
  it('hashes queue targets, items, ownership and bulkhead assignment as well as depths state', () => {
    const g = rich();
    g.sim.queueAdd(BLUE, 'surface', 'headframe', { x: 10.5, y: 10.5 });
    g.sim.queueAdd(BLUE, 'depths', 'bulkhead', { x: 12.5, y: 12.5 });
    const baseline = g.stateHash();
    const changes: ((copy: AgentCommandGame) => void)[] = [
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.item = 'turret'; },
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.x++; },
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.by = 'sky'; },
      (copy) => { copy.sim.armies[BLUE]!.queue[1]!.digger++; },
      (copy) => { copy.sim.armies[BLUE]!.queue[1]!.retry++; },
      (copy) => { copy.sim.armies[BLUE]!.queue.reverse(); },
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.heldAlloy++; },
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.heldEnergy++; },
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.funding = true; },
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.recovery = true; },
      (copy) => { copy.sim.armies[BLUE]!.queue[0]!.blockedAt = 0; },
      (copy) => { copy.sim.work[100] = 0.5; },
      (copy) => { copy.sim.tough[100] = copy.sim.tough[100]! + 1; },
      (copy) => { copy.sim.gate[100] = 1; },
      (copy) => { copy.sim.lodes[0]!.open = true; },
      (copy) => { copy.sim.lodes[0]!.left--; },
    ];
    for (const change of changes) {
      const copy = g.clone();
      change(copy);
      expect(copy.stateHash()).not.toBe(baseline);
    }
    expect(g.stateHash()).toBe(baseline);
  });

  it('mirrored queue orders keep a match exactly mirrored', () => {
    const g = createGame({ seed: 7 });
    const [a, b] = sites(g, 'nw', 2);
    const mirror = (team: ArmyId, p: { x: number; y: number }, width = 1) => (team === 'nw' ? p : { x: g.sim.size - width - p.x, y: g.sim.size - width - p.y });
    const script: [number, Plane, (team: ArmyId) => AgentCommandIntent][] = [
      [0, 'depths', () => ({ kind: 'queue_add', item: 'digger', count: 3 })],
      [0, 'surface', () => ({ kind: 'queue_add', item: 'tank' })],
      [1, 'surface', (team) => ({ kind: 'queue_add', item: 'turret', ...mirror(team, a!) })],
      [2, 'orbit', () => ({ kind: 'queue_add', item: 'solar', count: 2, index: 0 })],
      [40, 'orbit', () => ({ kind: 'queue_move', entry: 'q_6', index: 0 })],
      [60, 'surface', (team) => ({ kind: 'queue_add', item: 'shaft', ...mirror(team, b!, STATS.shaft.footprint.w) })],
      [80, 'depths', () => ({ kind: 'queue_cancel', entry: 'q_3' })],
      [200, 'surface', () => ({ kind: 'queue_cancel', entry: 'q_5' })],
    ];
    for (let tick = 0; tick < toTicks(40); tick++) {
      for (const [at, role, intent] of script) {
        if (at !== tick) continue;
        const results = (['nw', 'se'] as const).map((team) => act(g, team, role, intent(team)));
        expect(results[0], `tick ${tick} ${role}`).toEqual(results[1]);
      }
      g.step();
      const [blue, red] = (['nw', 'se'] as const).map((team) => queue(g, team).map(({ x, y, island, site, ...rest }) => ({ ...rest, at: x === undefined ? null : [Math.abs(x - (team === 'se' ? g.sim.size : 0)), Math.abs(y! - (team === 'se' ? g.sim.size : 0))] })));
      expect(red, `tick ${g.tick}`).toEqual(blue);
      expect(g.sim.armies[RED]!.alloy).toBe(g.sim.armies[BLUE]!.alloy);
      expect(g.sim.armies[RED]!.energy).toBe(g.sim.armies[BLUE]!.energy);
    }
    const kinds = (team: ArmyId) => g.sim.ents.filter((e) => e.side === slotOfArmyId(team, 2) && !e.dead).map((e) => e.kind).sort();
    expect(kinds('se')).toEqual(kinds('nw'));
    expect(queueEvents(g, 'se').map((e) => [e.kind, e.entry, e.index])).toEqual(queueEvents(g, 'nw').map((e) => [e.kind, e.entry, e.index]));
  });

  it("bots leave teammates' entries alone: they cancel and reorder only their own", () => {
    let toppled = 0;
    // The blue surface seat is someone else: it queues a tank at the top of the team queue every 10 s.
    const owner = {
      think(obs: Observation): AgentCommandIntent[] {
        if (obs.tick % toTicks(10) !== 0 || obs.queue.filter((q) => q.by === 'surface').length >= 4) return [];
        toppled++;
        return [{ kind: 'queue_add', item: 'tank', index: 0 }];
      },
    };
    const r = playBotMatch({ seed: 3, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: toTicks(240), seats: { nw: { surface: owner } } });
    expect(toppled).toBeGreaterThan(0);
    for (const team of (['nw', 'se'] as const)) {
      const evs = queueEvents(r.game, team);
      expect(evs.filter((e) => e.kind === 'queue_added').length).toBeGreaterThan(10);
      for (const e of evs) {
        if (e.kind === 'queue_added') continue;
        // Every cancel and move a bot made was on its own entry.
        expect(e.by, `${team} ${e.kind} ${e.entry}`).toBe(e.owner);
        if (e.kind === 'queue_moved') expect(e.index).toBeGreaterThanOrEqual(0);
      }
    }
    expect(queueEvents(r.game, 'nw').some((e) => e.owner === 'surface' && e.by !== 'surface')).toBe(false);
  });
});
