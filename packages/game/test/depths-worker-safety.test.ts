// @module-tag timing — sandbox calls and bounded stepped simulations run serially.
import { afterAll, describe, expect, it } from 'vitest';
import { loadPolicy, type PolicyInstance } from 'playerthree/policy';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { manifest } from '../src/agent/manifest.ts';
import { DECIDING_STARTERS, FUNCTIONAL_LIMITS, STARTER_POLICIES } from './starter-policies.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import { CELL, DEFAULT_RULES, TICK_RATE, type ArmyId, type Kind, type MatchData, type Observation } from '../src/rules/contract.ts';
import { diggerCarryMax } from '../src/rules/economy.ts';
import type { Ent } from '../src/sim/ent.ts';
import { SEP_DEADBAND } from '../src/sim/constants.ts';
import { canonX, canonY, rotCell, rotX, rotY } from '../src/util/teams.ts';

interface MiningFixture {
  game: AgentCommandGame;
  sim: AgentCommandGame['sim'];
  /** the fixture army's index, its first foe's, its seat and its frame; coordinates below are in that frame */
  army: number;
  foe: number;
  seat: { team: ArmyId; role: 'depths' };
  frame: number;
  cell(x: number, y?: number): number;
  set(x: number, y: number, kind: number): void;
  /** add a unit at canonical (x, y), standing in its cell */
  add(kind: Kind, side: number, x: number, y: number): Ent;
  /** world point of canonical (x, y) */
  at(x: number, y: number): { x: number; y: number };
  /** canonical position of a unit */
  canon(e: Ent): [number, number];
  /** the fixture army's name for an entity it owns or has seen (intents and observations use it) */
  id(e: Ent): string;
  workers: Ent[];
  data: MatchData;
  observe(): Observation;
}

const seat = { team: 'nw', role: 'depths' } as const;
const instances: PolicyInstance[] = [];
afterAll(() => { for (const instance of instances) instance.dispose(); });

/**
 * A Depths commander: a built-in bot, or a starter in the sandbox. By default the starter decides on its first call
 * too (most cases check that decision); `starter` swaps in another build, e.g. the default one for cases that call at
 * the host's cadence from the start, where its call before each decision prepares it (prepareAhead).
 */
async function commander(mode: 'policy' | 'standard' | 'veteran', data: MatchData, team: ArmyId = 'nw', starter = DECIDING_STARTERS.depths) {
  if (mode !== 'policy') {
    const bot = createBot(team, 'depths', mode);
    bot.init?.(data);
    return async (obs: Observation) => bot.think(obs);
  }
  const loaded = await loadPolicy('js', starter, FUNCTIONAL_LIMITS, { seed: 1, matchData: data });
  if (!loaded.ok) throw new Error(loaded.error.message ?? loaded.error.code);
  instances.push(loaded.instance);
  return async (obs: Observation) => {
    const result = await loaded.instance.call(obs);
    // Behaviour, not cost: the functional budget (depths-starter-budget.test.ts asserts the real one).
    if (!result.ok) throw new Error(`policy failed at tick ${obs.tick} after ${result.cpuMs ?? '?'} ms CPU (${result.ms} ms wall, budget ${FUNCTIONAL_LIMITS.msPerCall} ms CPU): ${result.error.code} ${result.error.message ?? ''}`);
    expect(result.value.dropped).toBe(0);
    return result.value.intents as AgentCommandIntent[];
  };
}

/**
 * A real one-cell known corridor, live home dropoff, two workers and ordinary ore. No hidden enemies in input.
 * Built for `army` (default the first) in its own frame: rotated armies get the exactly rotated scenario.
 */
function fixture(layout: { slots?: 2 | 4; army?: number; size?: number } = {}): MiningFixture {
  const params = { spireInset: 8, homeLodes: 0, contestedZones: [], ...(layout.slots === 4 ? { slots: 4 as const } : {}), ...(layout.size ? { size: layout.size } : {}) };
  const game = createGame({ seed: 21, options: { map: { params } } });
  const sim = game.sim, size = sim.size, army = layout.army ?? 0, foe = (army + 1) % sim.armies.length;
  const frame = sim.armyFrame[army]!;
  const team = sim.armyIds[army]!, armySeat = { team, role: 'depths' } as const;
  for (const e of sim.ents) if (e.kind !== 'spire') e.dead = true;
  sim.cells.fill(CELL.bedrock); sim.ore.fill(0); sim.lodeAt.fill(-1); sim.lodes.length = 0;
  sim.holes.fill(0); sim.gate.fill(0);
  for (const a of sim.armies) { a.alloy = 0; a.energy = 0; a.group.known.fill(CELL.bedrock); }
  const cell = (x: number, y = 8) => rotCell(frame, y * size + x, size);
  const set = (x: number, y: number, kind: number) => { sim.cells[cell(x, y)] = sim.armies[army]!.group.known[cell(x, y)] = kind; };
  const at = (x: number, y: number) => ({ x: rotX(frame, x, y, size), y: rotY(frame, x, y, size) });
  const add = (kind: Kind, side: number, x: number, y: number) => {
    const e = sim.add(kind, side, 'depths', rotX(frame, x, y, size), rotY(frame, x, y, size));
    if (e.unit) e.cell = cell(Math.floor(x), Math.floor(y));
    return e;
  };
  const canon = (e: Ent): [number, number] => [canonX(frame, e.x, e.y, size), canonY(frame, e.x, e.y, size)];
  for (let x = 10; x <= 35; x++) set(x, 8, CELL.tunnel);
  set(11, 9, CELL.ore); sim.ore[cell(11, 9)] = 100;
  const workers = [add('digger', army, 10.5, 8.5), add('digger', army, 11.5, 8.5)];
  sim.depthsVersion++;
  sim.refreshDrops();
  const data = game.matchData(armySeat);
  data.faults = [];
  const observe = () => {
    sim.computeVision(); // fixture edits must update real fog even between the sim's periodic vision ticks
    const obs = game.observe(armySeat, 0);
    obs.mandate.limits = { collapses: false };
    // Fixture terrain has no faults, holes or geothermal pockets; match generation's public identities are irrelevant.
    obs.pockets = []; obs.cracks = []; obs.holes = [];
    return obs;
  };
  const id = (e: Ent) => game.entityId(team, e.id);
  return { game, sim, army, foe, seat: armySeat, frame, cell, set, add, at, canon, id, workers, data, observe };
}

function openRich(f: MiningFixture) {
  const c = f.cell(32);
  f.sim.lodes.push({ c, rich: true, loads: 16, left: 128, open: true, known: 1, seenOpen: 1 });
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    f.set(32 + dx, 8 + dy, CELL.ore);
    f.sim.ore[f.cell(32 + dx, 8 + dy)] = 16;
    f.sim.lodeAt[f.cell(32 + dx, 8 + dy)] = 0;
  }
  const frame = f.sim.build(0, 'headframe', 32.5, 8.5, 'surface');
  frame.built = true; frame.progress = -1; frame.state = 'active'; frame.hp = frame.maxHp;
  f.sim.refreshDrops();
  return c;
}

const modes = ['policy', 'standard', 'veteran'] as const;
describe('depths worker safety', () => {
  for (const mode of modes) {
    function apply(game: AgentCommandGame, intents: AgentCommandIntent[], at: { team: ArmyId; role: 'depths' } = seat) {
      for (const intent of intents) expect(game.apply(at, intent, { source: mode === 'policy' ? 'policy' : 'bot' }), JSON.stringify(intent)).toEqual({ ok: true });
    }
    it(`${mode}: works safer ordinary ore instead of a rich pocket across an observed threat, then recovers`, async () => {
      const f = fixture();
      openRich(f);
      // The armed enemy is on the haul/access corridor, not at the rich ore (nine cells farther along).
      const scout = f.sim.add('trooper', 0, 'depths', 21.5, 8.5);
      const foe = f.sim.add('warden', 1, 'depths', 23.5, 8.5);
      f.game.step(); // update real vision from the scout before the policy sees the threat
      const decide = await commander(mode, f.data);
      const obs = f.observe();
      expect(obs.entities.some((e) => e.id === f.id(foe))).toBe(true);
      const first = await decide(obs);
      expect(first.some((i) => i.kind === 'mine' && i.x === 32.5)).toBe(false);
      expect(first.some((i) => i.kind === 'mine' && i.x === 11.5 && i.y === 9.5)).toBe(true);
      apply(f.game, first);
      for (let t = 0; t < 600; t++) f.game.step();
      expect(f.sim.armies[0]!.stats.alloyMined).toBeGreaterThan(0);
      expect(f.sim.armies[0]!.stats.lodeAlloy).toBe(0);
      foe.dead = true; scout.dead = true;
      f.game.step();
      let reassigned = false;
      // Carrying workers finish their existing delivery instead of discarding a productive trip.
      for (let t = 0; t < 400 && !reassigned; t++) {
        if (t % 10 === 0) {
          const recovered = await decide(f.observe());
          reassigned = recovered.some((i) => i.kind === 'mine' && i.x === 32.5);
          apply(f.game, recovered);
        }
        f.game.step();
      }
      expect(reassigned).toBe(true);
      for (let t = 0; t < 1400; t++) f.game.step();
      expect(f.sim.lodes[0]!.left).toBeLessThan(128);
      expect(f.sim.armies[0]!.stats.lodeAlloy).toBeGreaterThan(0);
    });

    it(`${mode}: assigns and delivers rich ore across a deployed friendly shield`, async () => {
      const f = fixture();
      openRich(f);
      const wall = f.sim.add('warden', 0, 'depths', 20.5, 8.5);
      expect(f.game.apply(seat, { kind: 'deploy', units: [f.id(wall)], on: true })).toEqual({ ok: true });
      for (let t = 0; t < 50; t++) f.game.step();
      const decide = await commander(mode, f.data);
      const out = await decide(f.observe());
      expect(out.some((i) => i.kind === 'mine' && i.x === 32.5)).toBe(true);
      apply(f.game, out);
      let crossed = false;
      for (let t = 0; t < 1400; t++) {
        f.game.step();
        crossed ||= f.workers.some((d) => d.x > wall.x + 1);
        expect(wall.state).toBe('walled');
      }
      expect(crossed).toBe(true);
      expect(f.sim.armies[0]!.stats.lodeAlloy).toBeGreaterThan(0);
    });

    it(`${mode}: separates coincident Wardens before deploying rather than freezing the overlap`, async () => {
      const f = fixture();
      const a = f.sim.add('warden', 0, 'depths', 18.5, 8.5);
      const b = f.sim.add('warden', 0, 'depths', 18.5, 8.5);
      f.sim.add('digger', 1, 'depths', 21.5, 8.5);
      const decide = await commander(mode, f.data);
      const first = await decide(f.observe());
      expect(first.some((i) => i.kind === 'deploy' && i.on)).toBe(false);
      apply(f.game, first);
      for (let t = 0; t < 100; t++) {
        f.game.step();
        if (t % 10 === 9) apply(f.game, await decide(f.observe()));
        if (a.deploy && b.deploy) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.radius + b.radius - SEP_DEADBAND);
      }
      expect(a.state === 'walled' || b.state === 'walled').toBe(true);
    });

    it(`${mode}: retreats or waits when a shield cuts all safe work, without forgetting it immediately in fog`, async () => {
      const f = fixture(), d = f.workers[0]!;
      f.workers[1]!.dead = true;
      f.set(11, 9, CELL.tunnel); f.sim.ore[f.cell(11, 9)] = 0;
      f.set(23, 8, CELL.ore); f.sim.ore[f.cell(23)] = 100;
      const wall = f.sim.add('warden', 1, 'depths', 18.5, 8.5);
      expect(f.game.apply({ team: 'se', role: 'depths' }, { kind: 'deploy', units: [f.game.entityId('se', wall.id)], on: true })).toEqual({ ok: true });
      for (let t = 0; t < 50; t++) f.game.step();
      d.x = 14.5; d.cell = f.cell(14);
      const decide = await commander(mode, f.data);
      expect(f.observe().entities.some((e) => e.id === f.id(wall))).toBe(true);
      for (let t = 0; t < 400; t++) {
        if (t % 10 === 0) apply(f.game, await decide(f.observe()));
        f.game.step();
        expect(d.x).toBeLessThanOrEqual(14.5);
        expect(d.dead).toBe(false);
      }
      expect(f.observe().entities.some((e) => e.id === f.id(wall))).toBe(false);
      expect(f.sim.ore[f.cell(23)]).toBe(100);
      // A genuine clear-cell sighting releases the remembered obstruction, not its unseen death alone.
      wall.hp = 0; f.game.step();
      f.sim.add('sapper', 0, 'depths', 17.5, 8.5);
      for (let t = 0; t < 700; t++) {
        if (t % 10 === 0) apply(f.game, await decide(f.observe()));
        f.game.step();
      }
      expect(f.sim.ore[f.cell(23)]).toBeLessThan(100);
      expect(f.sim.armies[0]!.stats.alloyMined).toBeGreaterThan(0);
    });

    it(`${mode}: deploys across worker service routes without trapping delivery`, async () => {
      for (const crossing of ['worker', 'destination'] as const) {
        const f = fixture();
        const w = f.sim.add('warden', 0, 'depths', 18.5, 8.5);
        f.sim.add('digger', 1, 'depths', 21.5, 8.5);
        const d = f.workers[0]!;
        if (crossing === 'worker') { d.x = 19.5; d.cell = f.cell(19); d.carry = 40; }
        else expect(f.game.apply(seat, { kind: 'move', units: [f.id(d)], x: 19.5, y: 8.5 })).toEqual({ ok: true });
        f.game.step();
        const decide = await commander(mode, f.data);
        const out = await decide(f.observe());
        expect(out.some((i) => i.kind === 'deploy' && i.on && i.units.includes(f.id(w)))).toBe(true);
        apply(f.game, out);
        if (crossing === 'worker') {
          for (let t = 0; t < 400; t++) {
            if (t % 10 === 0) apply(f.game, await decide(f.observe()));
            f.game.step();
          }
          expect(f.sim.armies[0]!.stats.alloyMined).toBeGreaterThanOrEqual(40);
        }
      }
    });

    it(`${mode}: keeps its defensive wall when a forward dropoff is lost`, async () => {
      for (const forward of ['none', 'shaft', 'headframe'] as const) {
        const f = fixture();
        const w = f.sim.add('warden', 0, 'depths', 18.5, 8.5);
        f.sim.add('digger', 1, 'depths', 21.5, 8.5);
        let drop: Ent | undefined;
        if (forward !== 'none') {
          const d = f.workers[0]!; d.x = 19.5; d.cell = f.cell(19); d.carry = 40;
          drop = f.sim.build(0, forward, 19.5, 8.5, 'surface');
          drop.built = true; drop.progress = -1; drop.state = 'active'; drop.hp = drop.maxHp;
          f.sim.refreshDrops();
          expect(f.game.apply(seat, { kind: 'mine', units: [f.id(d)] })).toEqual({ ok: true });
        }
        f.game.step();
        const decide = await commander(mode, f.data);
        const out = await decide(f.observe());
        expect(out.some((i) => i.kind === 'deploy' && i.on && i.units.includes(f.id(w)))).toBe(true);
        apply(f.game, out);
        for (let t = 0; t < 45; t++) f.game.step();
        expect(w.state).toBe('walled');
        if (drop) {
          expect(f.sim.armies[0]!.stats.alloyMined).toBeGreaterThanOrEqual(40);
          drop.dead = true;
          f.sim.refreshDrops();
          const reopen = await decide(f.observe());
          expect(reopen.some((i) => i.kind === 'deploy' && !i.on && i.units.includes(f.id(w)))).toBe(false);
          apply(f.game, reopen);
          for (let t = 0; t < 25; t++) f.game.step();
          expect(w.state).toBe('walled');
        }
      }
    });

    it(`${mode}: protects two productive hands from optional rail and repair work`, async () => {
      const f = fixture();
      f.sim.tick = 5000; f.sim.armies[0]!.alloy = 100;
      const decide = await commander(mode, f.data);
      const out = await decide(f.observe());
      expect(out.some((i) => i.kind === 'rail' || i.kind === 'fortify' || i.kind === 'bridge')).toBe(false);
      apply(f.game, out);
      for (let t = 0; t < 600; t++) f.game.step();
      expect(f.sim.armies[0]!.stats.alloyMined).toBeGreaterThan(0);
    });

    for (const cargo of [20, 40]) it(`${mode}: delivers preserved ${cargo}-alloy cargo despite a remote observed enemy, then resumes safe expansion`, async () => {
      const f = fixture(), d = f.workers[0]!, army = f.sim.armies[0]!;
      f.workers[1]!.dead = true;
      f.set(11, 9, CELL.tunnel); f.sim.ore[f.cell(11, 9)] = 0;
      d.x = 18.5; d.cell = f.cell(18); d.carry = cargo; d.lodeCarry = 10;
      const frame = f.sim.build(0, 'headframe', 35.5, 8.5, 'surface');
      frame.built = true; frame.progress = -1; frame.state = 'active';
      f.sim.add('sapper', 0, 'depths', 35.5, 8.5); // passive Depths sight; collapse orders are disabled by the fixture mandate
      const foe = f.sim.add('digger', 1, 'depths', 31.5, 8.5);
      f.set(29, 9, CELL.ore); f.sim.ore[f.cell(29, 9)] = 100; // only exposed ore is currently unsafe
      f.sim.depthsVersion++; f.sim.refreshDrops();
      // Called at the host's cadence from the start: the default starter, its call before each decision preparing it.
      const decide = await commander(mode, f.data, 'nw', STARTER_POLICIES.depths);
      expect(f.observe().entities.some((e) => e.id === f.id(foe))).toBe(true);
      let resumedMine = false;
      for (let t = 0; t < 500; t++) {
        if (t % 10 === 0) {
          const out = await decide(f.observe());
          resumedMine ||= out.some((i) => i.kind === 'mine' && i.units.includes(f.id(d)));
          apply(f.game, out);
        }
        f.game.step();
        expect(d.carry + army.stats.alloyMined).toBe(cargo);
        expect(d.lodeCarry + army.stats.lodeAlloy).toBe(10);
        expect(d.x).toBeLessThan(22); // the delivery handoff must not send it straight back to the dangerous ore
      }
      expect(resumedMine).toBe(true);
      expect(army.stats.alloyMined).toBe(cargo);
      expect(army.stats.lodeAlloy).toBe(10);
      expect(d.carry).toBe(0);
      expect(foe.dead).toBe(false);

      // Home ore is exhausted, but a safe dig-to-ore frontier is productive even while that enemy remains visible.
      f.set(11, 9, CELL.rock); f.set(11, 10, CELL.ore); f.sim.ore[f.cell(11, 10)] = 100;
      f.sim.depthsVersion++;
      for (let t = 0; t < 900; t++) {
        if (t % 10 === 0) apply(f.game, await decide(f.observe()));
        f.game.step();
      }
      expect(f.sim.cells[f.cell(11, 9)]).toBe(CELL.tunnel);
      expect(army.stats.alloyMined).toBeGreaterThan(cargo);
      expect(foe.dead).toBe(false);
    });

    for (const cargo of [20, 40]) it(`${mode}: preserves ${cargo}-alloy cargo when local danger cuts the dropoff route, and delivers after it clears`, async () => {
      const f = fixture(), d = f.workers[0]!, army = f.sim.armies[0]!;
      f.workers[1]!.dead = true;
      f.set(11, 9, CELL.tunnel); f.sim.ore[f.cell(11, 9)] = 0;
      d.x = 20.5; d.cell = f.cell(20); d.carry = cargo; d.lodeCarry = 10;
      const foe = f.sim.add('warden', 1, 'depths', 15.5, 8.5);
      // Called at the host's cadence from the start: the default starter, its call before each decision preparing it.
      const decide = await commander(mode, f.data, 'nw', STARTER_POLICIES.depths);
      expect(f.observe().entities.some((e) => e.id === f.id(foe))).toBe(true);
      for (let t = 0; t < 100; t++) {
        if (t % 10 === 0) {
          const out = await decide(f.observe());
          expect(out.some((i) => (i.kind === 'mine' || i.kind === 'move') && i.units.includes(f.id(d)))).toBe(false);
          apply(f.game, out);
        }
        f.game.step();
      }
      expect(d.carry).toBe(cargo);
      expect(army.stats.alloyMined).toBe(0);
      foe.dead = true;
      for (let t = 0; t < 500; t++) {
        if (t % 10 === 0) apply(f.game, await decide(f.observe()));
        f.game.step();
      }
      expect(d.carry).toBe(0);
      expect(army.stats.alloyMined).toBe(cargo);
      expect(army.stats.lodeAlloy).toBe(10);
    });

    /** The narrow-tunnel counterflow scenario in `f`'s army frame; its canonical trace, for comparing rotated armies. */
    async function safeRoute(f: MiningFixture): Promise<string[]> {
      const army = f.sim.armies[f.army]!, trace: string[] = [];
      const record = () => trace.push(JSON.stringify([f.sim.tick, army.stats.alloyMined, f.workers.map((d) => [...f.canon(d), d.carry, d.state])]));
      // The tempting ore is within mineNear of the safe target, but reached by a different corridor.
      // Before the fix: mine(28.5,9.5) selects (25,9), walks to x25.5, retreats to x16.5,
      // and repeats every 150 ticks (29 reversals, no extraction in a 2200-tick standard-bot trace).
      f.set(11, 9, CELL.tunnel); f.sim.ore[f.cell(11, 9)] = 0;
      for (let x = 26; x <= 35; x++) f.set(x, 8, CELL.bedrock);
      for (let y = 1; y < 8; y++) f.set(12, y, CELL.tunnel);
      for (let y = 1; y <= 9; y++) f.set(29, y, CELL.tunnel);
      for (let x = 12; x <= 29; x++) f.set(x, 1, CELL.tunnel);
      f.set(28, 9, CELL.ore); f.sim.ore[f.cell(28, 9)] = 100;
      f.set(25, 9, CELL.ore); f.sim.ore[f.cell(25, 9)] = 100;
      f.set(21, 13, CELL.tunnel); f.set(22, 13, CELL.tunnel);
      const foe = f.add('trooper', f.foe, 21.5, 13.5);
      const scout = f.add('sapper', f.army, 22.5, 13.5);
      foe.cd = 1e9; // observed weapon envelope without an unrelated fight killing the observer
      for (const d of f.workers) { const p = f.at(12.5, 8.5); d.x = p.x; d.y = p.y; d.cell = f.cell(12); }
      f.sim.depthsVersion++; f.sim.refreshDrops();
      // Called at the host's cadence from the start: the default starter, its call before each decision preparing it.
      const decide = await commander(mode, f.data, f.seat.team, STARTER_POLICIES.depths);
      for (let t = 0; t < 2600; t++) {
        if (t % 10 === 0) {
          army.alloy = army.energy = 0; // keep the fixture's two counterflow workers, not a growing army
          apply(f.game, await decide(f.observe()), f.seat);
          record();
        }
        f.game.step();
        for (const d of f.workers) {
          const [x, y] = f.canon(d);
          expect(d.dead).toBe(false);
          expect(y < 8 || x <= 16.5 || x >= 28).toBe(true);
        }
      }
      expect(f.sim.ore[f.cell(25, 9)]).toBe(100);
      expect(f.sim.ore[f.cell(28, 9)]).toBeLessThan(100);
      expect(army.stats.alloyMined).toBeGreaterThanOrEqual(80);

      // Losing delivery service must not keep the old mining commitment alive.
      army.spire.depths.hp = 0; army.spire.depths.dead = true; f.sim.refreshDrops();
      const mined = army.stats.alloyMined;
      for (let t = 0; t < 120; t++) {
        if (t % 10 === 0) { apply(f.game, await decide(f.observe()), f.seat); record(); }
        f.game.step();
      }
      expect(army.stats.alloyMined).toBe(mined);

      // A new dropoff, depleted old ore and a genuinely cleared/opened route permit productive retargeting.
      foe.dead = true; scout.dead = true;
      f.set(28, 9, CELL.tunnel); f.sim.ore[f.cell(28, 9)] = 0;
      for (let x = 26; x <= 29; x++) f.set(x, 8, CELL.tunnel);
      const p = f.at(29.5, 8.5), shaft = f.sim.build(f.army, 'shaft', p.x, p.y, 'surface');
      shaft.built = true; shaft.progress = -1; shaft.state = 'active';
      f.sim.depthsVersion++; f.sim.refreshDrops();
      for (let t = 0; t < 1200; t++) {
        if (t % 10 === 0) { army.alloy = army.energy = 0; apply(f.game, await decide(f.observe()), f.seat); record(); }
        f.game.step();
      }
      expect(f.sim.ore[f.cell(25, 9)]).toBeLessThan(100);
      expect(army.stats.alloyMined).toBeGreaterThan(mined);
      return trace;
    }

    /** A unit of `job` caught in a three-cell flood in `f`'s army frame; its canonical trace. */
    async function escapeLava(f: MiningFixture, job: 'idle' | 'mining' | 'hauling' | 'combat' | 'deployed'): Promise<string[]> {
      const trace: string[] = [], army = f.sim.armies[f.army]!;
      for (const d of f.workers) d.dead = true;
      const unit = f.add(job === 'combat' ? 'trooper' : job === 'deployed' ? 'warden' : 'digger', f.army, 21.5, 8.5);
      const id = f.id(unit);
      f.set(21, 9, CELL.ore); f.sim.ore[f.cell(21, 9)] = 100;
      if (job === 'mining' || job === 'hauling') {
        if (job === 'hauling') unit.carry = 40;
        apply(f.game, [{ kind: 'mine', units: [id], ...f.at(21.5, 9.5) }], f.seat);
        f.game.step();
      } else if (job === 'combat') {
        f.set(23, 9, CELL.tunnel);
        const target = f.add('geothermal', f.foe, 23.5, 9.5);
        target.hp = target.maxHp = 1e6;
        f.sim.computeVision();
        apply(f.game, [{ kind: 'attack', units: [id], target: f.id(target) }], f.seat);
        f.game.step();
      } else if (job === 'deployed') {
        apply(f.game, [{ kind: 'deploy', units: [id], on: true }], f.seat);
        for (let t = 0; t < 50; t++) f.game.step();
        expect(unit.state).toBe('walled');
      }
      const flood = { side: f.foe, origin: f.cell(21), cells: [] as number[], limit: 3, orbit: false,
        nextAt: Infinity, coolAt: f.sim.tick + 1000, knownAt: new Int32Array(4).fill(-1) };
      f.sim.floods.push(flood);
      for (let x = 20; x <= 22; x++) f.sim.floodCell(flood, f.cell(x));
      const decide = await commander(mode, f.data, f.seat.team), hp = unit.hp;
      let escaped = false, escapedHp = 0;
      for (let t = 0; t < 300; t++) {
        if (t % 10 === 0) {
          army.alloy = army.energy = 0;
          apply(f.game, await decide(f.observe()), f.seat);
        }
        f.game.step();
        const [x, y] = f.canon(unit);
        trace.push(JSON.stringify([x, y, unit.hp, unit.state]));
        expect(unit.dead).toBe(false);
        if (f.sim.cells[f.cell(Math.floor(x), Math.floor(y))] !== CELL.magma) {
          if (!escaped) { escaped = true; escapedHp = unit.hp; }
          expect(unit.hp).toBe(escapedHp);
        } else expect(escaped).toBe(false);
      }
      expect(escaped).toBe(true);
      expect(unit.hp).toBeLessThan(hp); // existing flood damage still lands until the unit gets out
      expect(f.sim.cells[f.cell(21)]).toBe(CELL.magma);
      return trace;
    }

    // C4 on a wider map: the scenario's far end must not sit under the neighbouring army's Spire.
    const layouts = [{ slots: 2 as const }, { slots: 4 as const, size: 64 }];
    for (const layout of layouts) {
      it(`${mode}: C${layout.slots}: every army retains a safe ore route instead of alternating mine-near and retreat in a narrow tunnel, exactly mirrored`, async () => {
        const traces: string[][] = [];
        for (let army = 0; army < layout.slots; army++) traces.push(await safeRoute(fixture({ ...layout, army })));
        for (const trace of traces.slice(1)) expect(trace).toEqual(traces[0]);
      });

      for (const job of ['idle', 'mining', 'hauling', 'combat', 'deployed'] as const) it(`${mode}: C${layout.slots}: every army escapes contiguous lava while ${job} and remains safe afterward, exactly mirrored`, async () => {
        const traces: string[][] = [];
        for (let army = 0; army < layout.slots; army++) traces.push(await escapeLava(fixture({ ...layout, army }), job));
        for (const trace of traces.slice(1)) expect(trace).toEqual(traces[0]);
      });
    }

    it(`${mode}: escapes lava through the flowing cells, never toward a located pocket beside it`, async () => {
      const f = fixture(), group = f.sim.armies[0]!.group;
      for (const d of f.workers) d.dead = true;
      const unit = f.add('digger', 0, 21.5, 8.5);
      for (let x = 21; x <= 23; x++) f.set(x, 8, CELL.magma);
      // The nearer "exit" past (20, 8) is a scanned pocket: code 7 like the flood, but solid rock in truth.
      f.set(20, 8, CELL.rock);
      group.known[f.cell(20)] = CELL.magma; group.pocketKnown[f.cell(20)] = 1; f.sim.magma[f.cell(20)] = 1;
      f.sim.depthsVersion++;
      const decide = await commander(mode, f.data);
      let out = false;
      for (let t = 0; t < 300 && !out; t++) {
        if (t % 10 === 0) {
          const obs = f.observe();
          obs.pockets = [{ x: 20, y: 8, id: 1 }];
          apply(f.game, await decide(obs));
        }
        f.game.step();
        out = f.sim.cells[f.cell(Math.floor(unit.x), Math.floor(unit.y))] !== CELL.magma;
      }
      expect(out).toBe(true);
      expect(unit.x).toBeGreaterThanOrEqual(24);
    });

    it(`${mode}: hands formerly guarded workers back to full-speed simulation hauling once the threat is gone`, async () => {
      // The same two-worker haul, with and without an observed armed enemy during the first phase.
      const haul = async (threat: boolean): Promise<number> => {
        const f = fixture(), army = f.sim.armies[0]!;
        f.set(11, 9, CELL.tunnel); f.sim.ore[f.cell(11, 9)] = 0;
        f.set(34, 9, CELL.ore); f.sim.ore[f.cell(34, 9)] = 255;
        // A sealed side pocket: the enemy is seen, but its weapon envelope never reaches the haul route.
        f.set(21, 20, CELL.tunnel); f.set(22, 20, CELL.tunnel);
        const scout = f.add('sapper', 0, 22.5, 20.5);
        const foe = threat ? f.add('trooper', 1, 21.5, 20.5) : undefined;
        if (foe) foe.cd = 1e9;
        f.sim.depthsVersion++;
        // Called at the host's cadence from the start: the default starter, its call before each decision preparing it.
        const decide = await commander(mode, f.data, 'nw', STARTER_POLICIES.depths);
        let guarded = false;
        const play = async (ticks: number) => {
          for (let t = 0; t < ticks; t++) {
            if (t % 10 === 0) {
              army.alloy = army.energy = 0;
              const out = await decide(f.observe());
              guarded ||= out.some((i) => (i.kind === 'mine' || i.kind === 'move') && i.x !== undefined && f.workers.some((d) => i.units.includes(f.id(d))));
              apply(f.game, out);
            }
            f.game.step();
          }
        };
        await play(800);
        if (threat) expect(guarded).toBe(true); // the bot really took the workers over while the enemy was in view
        if (foe) foe.dead = true;
        scout.dead = true;
        const before = army.stats.alloyMined;
        await play(3000);
        return army.stats.alloyMined - before;
      };
      const guarded = await haul(true), free = await haul(false);
      expect(free).toBeGreaterThan(0);
      // Phase offsets between the runs are at most one delivery per worker.
      expect(guarded).toBeGreaterThanOrEqual(free - 2 * diggerCarryMax(DEFAULT_RULES));
    });

    it(`${mode}: real enemy fire can still hurt an exposed worker while it withdraws`, async () => {
      const f = fixture(), worker = f.workers[0]!;
      worker.x = 19.5; worker.cell = f.cell(19);
      f.sim.add('trooper', 1, 'depths', 21.5, 8.5);
      const decide = await commander(mode, f.data);
      apply(f.game, await decide(f.observe()));
      for (let t = 0; t < 80; t++) f.game.step();
      expect(worker.hp).toBeLessThan(worker.maxHp);
    });
  }
});

describe('resumed mining cargo delivery', () => {
  it('delivers partial cargo through existing accounting once, not while merely walking across a dropoff', () => {
    const f = fixture(), d = f.workers[0]!, army = f.sim.armies[0]!;
    f.workers[1]!.dead = true;
    d.x = 11.5; d.cell = f.cell(11); d.carry = 20; d.lodeCarry = 10;
    expect(f.game.apply(seat, { kind: 'move', units: [f.id(d)], x: 10.5, y: 8.5 })).toEqual({ ok: true });
    for (let t = 0; t < 80; t++) f.game.step();
    expect(d.carry).toBe(20);
    expect(army.stats.alloyMined).toBe(0);
    expect(army.drop[f.cell(Math.floor(d.x), Math.floor(d.y))]).toBe(1);
    const before = army.alloy;
    for (let t = 0; t < 5; t++) {
      expect(f.game.apply(seat, { kind: 'mine', units: [f.id(d)] })).toEqual({ ok: true });
      f.game.step();
      expect(d.carry).toBe(0);
      expect(d.lodeCarry).toBe(0);
      expect(army.stats.alloyMined).toBe(20);
      expect(army.stats.lodeAlloy).toBe(10);
      expect(army.alloy).toBeCloseTo(before + 20 + (t + 1) * f.sim.econ.spireAlloyRate / TICK_RATE);
    }
  });

  it('keeps normal adjacent-dropoff extraction cadence instead of unloading each partial load', () => {
    const f = fixture(), d = f.workers[0]!, army = f.sim.armies[0]!;
    f.workers[1]!.dead = true;
    f.set(10, 9, CELL.ore); f.sim.ore[f.cell(10, 9)] = 100;
    f.sim.depthsVersion++; f.sim.refreshDrops();
    expect(army.drop[f.cell(10)]).toBe(1);
    expect(f.game.apply(seat, { kind: 'mine', units: [f.id(d)], x: 10.5, y: 9.5 })).toEqual({ ok: true });
    for (let t = 0; t < 3 * f.sim.econ.digOre; t++) f.game.step();
    expect(d.carry).toBe(30);
    expect(army.stats.alloyMined).toBe(0);
    for (let t = 0; t < f.sim.econ.digOre + 3; t++) f.game.step();
    expect(army.stats.alloyMined).toBe(40);
    expect(d.carry).toBe(0);
  });

  for (const side of [0, 1] as const) for (const drop of ['root', 'shaft', 'headframe'] as const) {
    it(`credits preserved cargo exactly once at side ${side}'s live ${drop}`, () => {
      const f = fixture(), army = f.sim.armies[side]!;
      for (const worker of f.workers) worker.dead = true;
      const homeX = drop === 'root' ? 10 : 20;
      const x = side === 0 ? homeX : f.sim.size - 1 - homeX, y = side === 0 ? 8 : f.sim.size - 9;
      f.set(x, y, CELL.tunnel);
      army.group.known[f.cell(x, y)] = CELL.tunnel;
      if (drop !== 'root') {
        const structure = f.sim.build(side, drop, x + 0.5, y + 0.5, 'surface');
        structure.built = true; structure.progress = -1; structure.state = 'active';
      }
      const d = f.sim.add('digger', side, 'depths', x + 0.5, y + 0.5);
      d.carry = 20; d.lodeCarry = 10;
      f.sim.refreshDrops();
      expect(army.drop[f.cell(x, y)]).toBe(1);
      for (let t = 0; t < 5; t++) {
        expect(f.game.apply({ team: side === 0 ? 'nw' : 'se', role: 'depths' }, { kind: 'mine', units: [f.game.entityId(side === 0 ? 'nw' : 'se', d.id)] })).toEqual({ ok: true });
        f.game.step();
        expect(d.carry).toBe(0);
        expect(d.lodeCarry).toBe(0);
        expect(army.stats.alloyMined).toBe(20);
        expect(army.stats.lodeAlloy).toBe(10);
      }
    });
  }

  for (const drop of ['none', 'foreign', 'dead', 'unfinished'] as const) {
    it(`does not credit preserved cargo at a ${drop} dropoff`, () => {
      const f = fixture(), d = f.workers[0]!, army = f.sim.armies[0]!;
      f.workers[1]!.dead = true;
      army.spire.depths.dead = true; army.spire.depths.hp = 0;
      f.set(11, 9, CELL.tunnel); f.sim.ore[f.cell(11, 9)] = 0;
      d.x = 20.5; d.cell = f.cell(20); d.carry = 20; d.lodeCarry = 10;
      if (drop !== 'none') {
        const shaft = f.sim.build(drop === 'foreign' ? 1 : 0, 'shaft', 20.5, 8.5, 'surface');
        shaft.built = drop !== 'unfinished'; shaft.dead = drop === 'dead';
      }
      f.sim.refreshDrops();
      expect(army.drop[f.cell(20)]).toBe(0);
      expect(f.game.apply(seat, { kind: 'mine', units: [f.id(d)] })).toEqual({ ok: true });
      for (let t = 0; t < 80; t++) f.game.step();
      expect(d.carry).toBe(20);
      expect(d.lodeCarry).toBe(10);
      expect(army.stats.alloyMined).toBe(0);
      expect(army.stats.lodeAlloy).toBe(0);
    });
  }
});

describe('depths lava move admission', () => {
  it('admits a flooded occupant leaving contiguous magma, but not ordinary entry or re-entry', () => {
    const f = fixture(), d = f.workers[0]!;
    f.workers[1]!.dead = true;
    for (let x = 20; x <= 22; x++) f.set(x, 8, CELL.magma);
    f.sim.depthsVersion++;
    const move = (x: number) => f.game.apply(seat, { kind: 'move', units: [f.id(d)], x, y: 8.5 });
    d.x = 19.5; d.y = 8.5; d.cell = f.cell(19);
    expect(move(23.5)).toEqual({ ok: false, code: 'no_path' });
    d.x = 21.5; d.cell = f.cell(21);
    expect(move(19.5)).toEqual({ ok: true });
    for (let t = 0; t < 40; t++) f.game.step();
    expect(d.x).toBe(19.5);
    expect(move(23.5)).toEqual({ ok: false, code: 'no_path' });
    // Merely remembered/scanned magma under a now-safe unit does not authorize crossing lava.
    f.set(19, 8, CELL.magma); f.sim.cells[f.cell(19)] = CELL.tunnel;
    expect(move(23.5)).toEqual({ ok: false, code: 'no_path' });
  });

  it('never admits an escape through a located solid pocket that shares the magma code, for either army', () => {
    for (const army of [0, 1]) {
      const f = fixture({ army }), d = f.workers[0]!, group = f.sim.armies[army]!.group;
      f.workers[1]!.dead = true;
      for (const x of [21, 22]) f.set(x, 8, CELL.magma);
      // A scanned pocket: solid rock in truth, code 7 in the team's knowledge, beside the flowing magma.
      f.set(23, 8, CELL.rock);
      group.known[f.cell(23)] = CELL.magma; group.pocketKnown[f.cell(23)] = 1; f.sim.magma[f.cell(23)] = 1;
      f.sim.depthsVersion++;
      const p = f.at(21.5, 8.5);
      d.x = p.x; d.y = p.y; d.cell = f.cell(21);
      const move = (x: number) => f.game.apply(f.seat, { kind: 'move', units: [f.id(d)], ...f.at(x, 8.5) });
      expect(move(24.5)).toEqual({ ok: false, code: 'no_path' });
      expect(move(19.5)).toEqual({ ok: true });
    }
  });

  for (const start of ['standing in the flood', 'engulfed on a dry route'] as const) {
    it(`leaves the lava by the fewest magma cells when ${start}, exactly mirrored`, () => {
      const traces = [0, 1].map((army) => {
        const f = fixture({ army }), d = f.workers[0]!, trace: string[] = [];
        f.workers[1]!.dead = true;
        // A dry detour round the flood: up column 19, along row 4, down column 27.
        for (let y = 4; y < 8; y++) { f.set(19, y, CELL.tunnel); f.set(27, y, CELL.tunnel); }
        for (let x = 19; x <= 27; x++) f.set(x, 4, CELL.tunnel);
        const from = start === 'standing in the flood' ? 20 : 21, p = f.at(from + 0.5, 8.5);
        d.x = p.x; d.y = p.y; d.cell = f.cell(from);
        const flood = () => { for (let x = 20; x <= 26; x++) f.set(x, 8, CELL.magma); f.sim.depthsVersion++; };
        if (start === 'standing in the flood') flood();
        f.sim.depthsVersion++;
        expect(f.game.apply(f.seat, { kind: 'move', units: [f.id(d)], ...f.at(30.5, 8.5) })).toEqual({ ok: true });
        f.game.step();
        if (start === 'engulfed on a dry route') flood();
        const allowed = new Set([f.cell(from), f.cell(20)]);
        for (let t = 0; t < 600; t++) {
          f.game.step();
          const [x, y] = f.canon(d), c = f.cell(Math.floor(x), Math.floor(y));
          // Wading straight across is shorter, but every extra magma cell costs more than the whole dry detour.
          if (f.sim.cells[c] === CELL.magma) expect(allowed.has(c), `tick ${t} in magma at ${x}, ${y}`).toBe(true);
          trace.push(`${x},${y},${d.hp}`);
        }
        expect(d.dead).toBe(false);
        expect(f.canon(d)).toEqual([30.5, 8.5]);
        return trace;
      });
      expect(traces[1]).toEqual(traces[0]);
    });
  }
});
