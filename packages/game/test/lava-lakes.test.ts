/**
 * Permanent lava lakes (map.lavaLakes), lava bridges (`bridge` on a lake cell) and green rich ore (map.richOre):
 * generation symmetry and the dry way round, burning without cooling, building, crossing and cutting bridges, span
 * and fog rules, and richer mining. Every scenario runs for each army of a C2 and a C4 match, rotated into its frame,
 * and the armies' canonical traces must match exactly.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { BRIDGE_REBUILD_CALM, RICH_BRIDGE_DIGGERS, TIERS } from '../src/bots/tuning.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { CELL, resolveRules, type ArmyId, type Kind, type MatchData, type Observation } from '../src/rules/contract.ts';
import { validateMapDocument } from '../src/maps/document.ts';
import { generateTerrain, generateWorld } from '../src/maps/world.ts';
import type { Ent } from '../src/sim/ent.ts';
import { canonX, canonY, rotCell, rotX, rotY } from '../src/util/teams.ts';

const LAKES = { lavaLakes: { enabled: true }, richOre: { enabled: true } } as const;
/** Ticks a new bridge stands before a scenario cuts it: two decisions of the slowest tier driven (standard). */
const BRIDGE_SEEN = 2 * TIERS.standard.period;
/** Canonical x of a scenario moat's first lake column on the tunnel row (moat). */
const MOAT_X = 24;

describe('lava lake and rich ore generation', () => {
  for (const [slots, size] of [[2, 48], [4, 64]] as const) for (const seed of [3, 9]) {
    it(`C${slots} seed ${seed}: exactly symmetric, valid, and every army keeps a dry way to the centre`, () => {
      const g = createGame({ seed, options: { map: { seed, params: { slots, size, ...LAKES } } } });
      const s = g.sim, n = s.size;
      let lava = 0, rich = 0;
      for (let c = 0; c < s.n; c++) {
        expect(s.cells[rotCell(4 / slots, c, n)]).toBe(s.cells[c]);
        expect(s.ore[rotCell(4 / slots, c, n)]).toBe(s.ore[c]);
        if (s.cells[c] === CELL.lake) lava++;
        if (s.cells[c] === CELL.rich) { rich++; expect(s.ore[c]).toBe(DEFAULT_RICH_LOADS); }
      }
      expect(lava).toBeGreaterThan(0);
      expect(rich).toBeGreaterThan(0);
      expect(validateMapDocument(s.mapDocument).errors).toEqual([]);
      expect(s.generation.stages.map((stage) => stage.name)).toContain('lava');
      // Rich ore is public: every army knows it from the start; the lakes stay hidden until seen.
      for (const t of s.armies) for (let c = 0; c < s.n; c++) if (s.cells[c] === CELL.rich) expect(t.group.known[c]).toBe(CELL.rich);
      for (const a of s.allArmies) {
        const home = s.spireAt[a]!, start = Math.floor(home.y) * n + Math.floor(home.x);
        const seen = new Uint8Array(s.n), queue = [start];
        seen[start] = 1;
        for (let i = 0; i < queue.length; i++) for (const m of [queue[i]! + 1, queue[i]! - 1, queue[i]! + n, queue[i]! - n]) {
          if (m >= 0 && m < s.n && !seen[m] && (s.cells[m] === CELL.tunnel || s.cells[m] === CELL.rail)) { seen[m] = 1; queue.push(m); }
        }
        let centre = false;
        for (let c = 0; c < s.n; c++) if (seen[c] && Math.hypot(c % n + 0.5 - n / 2, Math.floor(c / n) + 0.5 - n / 2) < 4) centre = true;
        expect(centre).toBe(true);
      }
    });
  }

  it('default maps have lakes and rich ore; turning both off removes them and the lava stage', () => {
    for (const slots of [2, 4] as const) {
      const plain = createGame({ seed: 4, options: { map: { seed: 4, params: { slots } } } }).sim;
      const off = createGame({ seed: 4, options: { map: { seed: 4, params: { slots, lavaLakes: { enabled: false }, richOre: { enabled: false } } } } }).sim;
      expect(plain.cells.includes(CELL.lake)).toBe(true);
      expect(plain.generation.stages.map((stage) => stage.name)).toContain('lava');
      expect(off.mapHash).not.toBe(plain.mapHash);
      expect(off.cells.includes(CELL.lake)).toBe(false);
      expect(off.cells.includes(CELL.rich)).toBe(false);
      expect(off.generation.stages.map((stage) => stage.name)).not.toContain('lava');
    }
  });

  // Rich ore used to be reserved before the lode sites, and its moat box took the last flank sites on these maps.
  it('rich ore never costs a lode site: lode zones match the maps without it, and every cluster is placed', () => {
    for (const [preset, size, seed] of [['canyons', 48, 9], ['canyons', 48, 17], ['archipelago', 64, 3]] as const) {
      const lodes = (rich: boolean) => {
        const map = resolveRules({ terrain: preset, map: { params: { size, richOre: { enabled: rich } } } }).map;
        const world = generateWorld(seed, generateTerrain(seed, preset, map, 4), map, 4, seed);
        return { zones: world.generation.lodes, rich: world.cells.filter((v) => v === CELL.rich).length, map };
      };
      const on = lodes(true), off = lodes(false);
      expect(on.zones, `${preset}/${size}/${seed}`).toEqual(off.zones);
      for (const zone of on.zones) expect(zone.missing, `${preset}/${size}/${seed} ${zone.zone}`).toBe(0);
      expect(on.rich).toBe(4 * on.map.richOre.clusters * on.map.richOre.cells);
    }
  });
});

const DEFAULT_RICH_LOADS = createGame({ seed: 1 }).sim.rules.map.richOre.loads;

interface Fixture {
  g: AgentCommandGame;
  s: AgentCommandGame['sim'];
  army: number;
  foe: number;
  team: ArmyId;
  cell(x: number, y: number): number;
  set(x: number, y: number, code: number, known?: boolean): void;
  lake(x: number, y: number): void;
  add(kind: Kind, side: number, x: number, y: number): Ent;
  at(x: number, y: number): { x: number; y: number };
  canon(e: Ent): string;
}

/** A bedrock world for `army` (canonical frame): a tunnel row y = 8 from the root out to x = 30. */
function fixture(slots: 2 | 4, army: number): Fixture {
  // No Spire trickle: bridge payments are the only alloy movement.
  const g = createGame({ seed: 21, options: { economy: { spireAlloyRate: 0 }, map: { params: { spireInset: 8, homeLodes: 0, contestedZones: [], slots, ...(slots === 4 ? { size: 64 } : {}) } } } });
  const s = g.sim, n = s.size, frame = s.armyFrame[army]!;
  for (const e of s.ents) if (e.kind !== 'spire') e.dead = true;
  s.cells.fill(CELL.bedrock); s.ore.fill(0); s.holes.fill(0); s.gate.fill(0);
  for (const a of s.armies) { a.alloy = 1000; a.energy = 0; a.group.known.fill(CELL.bedrock); }
  const cell = (x: number, y: number) => rotCell(frame, y * n + x, n);
  const set = (x: number, y: number, code: number, known = true) => {
    s.cells[cell(x, y)] = code;
    if (known) s.armies[army]!.group.known[cell(x, y)] = code;
  };
  const lake = (x: number, y: number) => set(x, y, CELL.lake);
  const at = (x: number, y: number) => ({ x: rotX(frame, x, y, n), y: rotY(frame, x, y, n) });
  const add = (kind: Kind, side: number, x: number, y: number) => {
    const e = s.add(kind, side, 'depths', rotX(frame, x, y, n), rotY(frame, x, y, n));
    if (e.unit) e.cell = cell(Math.floor(x), Math.floor(y));
    return e;
  };
  const canon = (e: Ent) => `${canonX(frame, e.x, e.y, n)},${canonY(frame, e.x, e.y, n)},${e.hp},${e.state}`;
  for (let x = 10; x <= 30; x++) set(x, 8, CELL.tunnel);
  s.depthsVersion++;
  s.refreshDrops();
  return { g, s, army, foe: (army + 1) % s.armies.length, team: s.armyIds[army]!, cell, set, lake, add, at, canon };
}

/** Run `scenario` for every army of a C2 and a C4 match; their canonical traces must match exactly. */
function mirrored(name: string, scenario: (f: Fixture) => string[]): void {
  for (const slots of [2, 4] as const) it(`C${slots}: ${name}, exactly mirrored for every army`, () => {
    const traces: string[][] = [];
    for (let army = 0; army < slots; army++) traces.push(scenario(fixture(slots, army)));
    for (const trace of traces.slice(1)) expect(trace).toEqual(traces[0]);
  });
}

describe('lava lakes', () => {
  mirrored('a lake burns whoever stands in it and never cools', (f) => {
    f.lake(20, 8);
    const d = f.add('digger', f.army, 20.5, 8.5), hp = d.hp, trace: string[] = [];
    for (let t = 0; t < f.s.econ.magmaCoolTicks + 20; t++) {
      f.g.step();
      if (d.dead) break;
      trace.push(f.canon(d));
    }
    expect(d.hp).toBeLessThan(hp);
    expect(f.s.cells[f.cell(20, 8)]).toBe(CELL.lake);
    return trace;
  });

  mirrored('a flood never spreads onto a lava bridge', (f) => {
    f.lake(20, 8);
    f.s.placeLavaBridge(f.cell(20, 8), f.army);
    f.s.magma[f.cell(22, 9)] = 9;
    f.set(22, 9, CELL.rock);
    f.s.breakPocket(f.cell(22, 9), f.foe);
    for (let t = 0; t < 400; t++) f.g.step();
    expect(f.s.cells[f.cell(20, 8)]).toBe(CELL.bridge);
    return [String(f.s.cells[f.cell(21, 8)]), String(f.s.cells[f.cell(19, 8)])];
  });
});

describe('lava bridges', () => {
  mirrored('diggers bridge a lake span from dry ground, walk it, and lose it to combat', (f) => {
    for (let x = 20; x <= 22; x++) f.lake(x, 8);
    f.s.depthsVersion++;
    const d = f.add('digger', f.army, 12.5, 8.5), id = f.g.entityId(f.team, d.id), seat = { team: f.team, role: 'depths' } as const, trace: string[] = [];
    const army = f.s.armies[f.army]!, alloy = army.alloy;
    // Out of span: only the lake cell beside dry ground can start a span.
    expect(f.g.apply(seat, { kind: 'bridge', units: [id], ...cellXY(f, 21, 8) })).toEqual({ ok: false, code: 'invalid_target' });
    for (const x of [20, 21, 22]) {
      expect(f.g.apply(seat, { kind: 'bridge', units: [id], ...cellXY(f, x, 8) })).toEqual({ ok: true });
      for (let t = 0; t < 400 && f.s.cells[f.cell(x, 8)] !== CELL.bridge; t++) { f.g.step(); trace.push(f.canon(d)); }
      expect(f.s.cells[f.cell(x, 8)]).toBe(CELL.bridge);
    }
    expect(army.alloy).toBe(alloy - 3 * f.s.econ.lavaBridgeCost);
    const bridges = f.s.ents.filter((e) => e.kind === 'lava_bridge' && !e.dead);
    expect(bridges).toHaveLength(3);
    // Walk across, then the middle span falls under the walker: it is in lava and gets out by the escape rules.
    expect(f.g.apply(seat, { kind: 'move', units: [id], ...f.at(25.5, 8.5) })).toEqual({ ok: true });
    for (let t = 0; t < 200; t++) { f.g.step(); trace.push(f.canon(d)); }
    expect(canonX(f.s.armyFrame[f.army]!, d.x, d.y, f.s.size)).toBe(25.5);
    expect(f.g.apply(seat, { kind: 'move', units: [id], ...f.at(12.5, 8.5) })).toEqual({ ok: true });
    const middle = f.s.byId.get(f.s.bridgeAt[f.cell(21, 8)]!)!;
    for (let t = 0; t < 200; t++) {
      f.g.step();
      if (Math.floor(canonX(f.s.armyFrame[f.army]!, d.x, d.y, f.s.size)) === 21 && !middle.dead) f.s.damage(middle, middle.hp, f.foe, false, 'collapse');
      trace.push(f.canon(d));
    }
    expect(middle.dead).toBe(true);
    expect(f.s.cells[f.cell(21, 8)]).toBe(CELL.lake);
    expect(d.dead).toBe(false);
    return trace;
  });

  mirrored('a charge cuts every bridge within reach; flood magma is never bridged', (f) => {
    f.lake(20, 8);
    f.s.placeLavaBridge(f.cell(20, 8), f.army);
    const seat = { team: f.team, role: 'depths' } as const;
    const d = f.add('digger', f.army, 15.5, 8.5);
    // A flood (not a lake) next to dry ground is not bridgeable.
    f.set(16, 9, CELL.magma);
    f.set(16, 10, CELL.tunnel);
    expect(f.g.apply(seat, { kind: 'bridge', units: [f.g.entityId(f.team, d.id)], ...cellXY(f, 16, 9) })).toEqual({ ok: false, code: 'invalid_target' });
    f.s.plantCharge(f.foe, f.cell(19, 8));
    for (let t = 0; t < f.s.econ.undermineTicks + 5; t++) f.g.step();
    expect(f.s.cells[f.cell(20, 8)]).toBe(CELL.lake);
    expect(f.s.ents.some((e) => e.kind === 'lava_bridge' && !e.dead)).toBe(false);
    return [String(f.s.cells[f.cell(20, 8)])];
  });

  mirrored('an army learns of a bridge only by seeing it', (f) => {
    f.lake(20, 8);
    const foe = f.s.armies[f.foe]!;
    foe.group.known[f.cell(20, 8)] = CELL.lake;
    f.s.placeLavaBridge(f.cell(20, 8), f.army);
    f.s.computeVision();
    expect(foe.group.known[f.cell(20, 8)]).toBe(CELL.lake);
    const obs = f.g.observe({ team: f.s.armyIds[f.foe]!, role: 'depths' }, 0);
    expect(obs.entities.some((e) => e.kind === 'lava_bridge')).toBe(false);
    f.add('digger', f.foe, 19.5, 8.5);
    f.s.computeVision();
    expect(foe.group.known[f.cell(20, 8)]).toBe(CELL.bridge);
    return [String(foe.group.known[f.cell(20, 8)])];
  });
});

describe('green rich ore', () => {
  mirrored('a digger mines rich loads, richer than ordinary ore', (f) => {
    f.set(15, 9, CELL.rich);
    f.s.ore[f.cell(15, 9)] = 4;
    const d = f.add('digger', f.army, 15.5, 8.5), trace: string[] = [];
    const seat = { team: f.team, role: 'depths' } as const;
    expect(f.g.apply(seat, { kind: 'mine', units: [f.g.entityId(f.team, d.id)], ...f.at(15.5, 9.5) })).toEqual({ ok: true });
    const army = f.s.armies[f.army]!;
    for (let t = 0; t < 2 * f.s.econ.digRich + 200; t++) { f.g.step(); trace.push(`${f.canon(d)},${d.carry}`); }
    expect(army.stats.alloyMined).toBeGreaterThanOrEqual(2 * f.s.econ.richLoad);
    expect(f.s.econ.richLoad).toBeGreaterThan(f.s.econ.oreLoad);
    return trace;
  });
});

/**
 * Drive `f`'s Depths seat with the `level` bot or the example Depths policy for up to `ticks`, applying every intent;
 * `until` ends early, `each` runs before every step. Bridge, mine, attack and undermine orders must be accepted.
 */
function drive(f: Fixture, level: 'standard' | 'veteran' | 'policy', ticks: number, until: () => boolean, trace: string[], each?: (t: number) => void): AgentCommandIntent[] {
  const seat = { team: f.team, role: 'depths' } as const, sent: AgentCommandIntent[] = [];
  const brain = level === 'policy'
    ? runInNewContext(`${STARTER_POLICIES.depths}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] }
    : createBot(f.team, 'depths', level);
  brain.init?.(f.g.matchData(seat));
  for (let t = 0; t < ticks && !until(); t++) {
    if (t % BOT_PERIOD === 0) for (const intent of structuredClone(brain.think(f.g.observe(seat, 0)))) {
      const ack = f.g.apply(seat, intent);
      if (['bridge', 'mine', 'attack', 'undermine', 'deploy'].includes(intent.kind)) {
        expect(ack, JSON.stringify(intent)).toEqual({ ok: true });
        sent.push(intent);
        // Cell intents carry cell indices, `mine` a point: both trace as the canonical cell.
        const frame = f.s.armyFrame[f.army]!, half = intent.kind === 'mine' ? 0 : 0.5;
        const where = 'x' in intent && intent.x !== undefined ? `${Math.floor(canonX(frame, intent.x + half, intent.y! + half, f.s.size))},${Math.floor(canonY(frame, intent.x + half, intent.y! + half, f.s.size))}` : '';
        trace.push(`${t}:${intent.kind}:${where}`);
      }
    }
    each?.(t);
    f.g.step();
  }
  return sent;
}

/**
 * A lava moat `width` cells wide across the tunnel at x = MOAT_X on, rock beyond it (over the tunnel's end), a rich cell
 * in the rock, and a home crew of RICH_BRIDGE_DIGGERS diggers. MOAT_X keeps the rich cell nearer our Spire than the
 * next army's on the C4 map (the bots take rich ore on their own side only).
 */
function moat(f: Fixture, width: number): void {
  for (let y = 5; y <= 11; y++) {
    for (let x = MOAT_X; x < MOAT_X + width; x++) f.lake(x, y);
    for (let x = MOAT_X + width; x <= 30; x++) f.set(x, y, CELL.rock);
  }
  f.set(MOAT_X + width + 1, 8, CELL.rich);
  f.s.ore[f.cell(MOAT_X + width + 1, 8)] = 8;
  for (let i = 0; i < RICH_BRIDGE_DIGGERS; i++) f.add('digger', f.army, 12.5 + i, 8.5);
  f.s.depthsVersion++;
}

describe('depths bots and the example policy on lava', () => {
  for (const level of ['standard', 'veteran', 'policy'] as const) {
    mirrored(`${level} bridges the lava moat to green rich ore and mines it`, (f) => {
      moat(f, 2);
      const trace: string[] = [], army = f.s.armies[f.army]!;
      const sent = drive(f, level, 9000, () => army.stats.alloyMined >= f.s.econ.richLoad, trace);
      expect(sent.filter((i) => i.kind === 'bridge').length).toBeGreaterThanOrEqual(1);
      expect(f.s.cells[f.cell(MOAT_X, 8)]).toBe(CELL.bridge);
      expect(army.stats.alloyMined).toBeGreaterThanOrEqual(f.s.econ.richLoad);
      return trace;
    });

    mirrored(`${level} pays a moat bridge from its own lane's hold while the free bank is empty`, (f) => {
      moat(f, 1);
      // Every alloy is our Depths lane head's hold: a Warden saving with no energy to start on.
      const army = f.s.armies[f.army]!, seat = { team: f.team, role: 'depths' } as const;
      army.alloy = f.s.econ.lavaBridgeCost + f.s.econ.oreLoad;
      expect(f.g.apply(seat, { kind: 'queue_add', item: 'warden' })).toEqual({ ok: true });
      f.g.step();
      const res = f.g.observe(seat, 0).res;
      expect(res.freeAlloy).toBeLessThan(f.s.econ.lavaBridgeCost);
      expect(res.heldAlloy).toBeGreaterThanOrEqual(f.s.econ.lavaBridgeCost);
      const trace: string[] = [];
      const sent = drive(f, level, 9000, () => army.stats.alloyMined >= f.s.econ.richLoad, trace);
      expect(sent.some((i) => i.kind === 'bridge')).toBe(true);
      expect(army.stats.alloyMined).toBeGreaterThanOrEqual(f.s.econ.richLoad);
      return trace;
    });

    mirrored(`${level} bridges again only BRIDGE_REBUILD_CALM after a hostile cuts its bridge`, (f) => {
      moat(f, 1);
      const trace: string[] = [], army = f.s.armies[f.army]!;
      let stoodAt = -1, cutAt = -1;
      const sent = drive(f, level, 12_000, () => army.stats.alloyMined >= f.s.econ.richLoad, trace, (t) => {
        const id = f.s.bridgeAt[f.cell(MOAT_X, 8)]!;
        if (cutAt >= 0 || !id) return;
        if (stoodAt < 0) stoodAt = t;
        // Cut once every tier's bot has decided with the bridge standing (it knows the bridge as its own).
        if (t - stoodAt < BRIDGE_SEEN) return;
        const deck = f.s.byId.get(id)!;
        f.s.damage(deck, deck.hp, f.foe, false, 'collapse');
        cutAt = t;
        trace.push(`${t}:cut`);
      });
      expect(cutAt).toBeGreaterThanOrEqual(0);
      const again = trace.filter((s) => s.endsWith(`:bridge:${MOAT_X},8`)).map((s) => Number(s.split(':')[0])).filter((t) => t > cutAt);
      expect(again.length).toBeGreaterThanOrEqual(1);
      expect(again[0]! - cutAt).toBeGreaterThanOrEqual(BRIDGE_REBUILD_CALM);
      expect(army.stats.alloyMined).toBeGreaterThanOrEqual(f.s.econ.richLoad);
      expect(sent.filter((i) => i.kind === 'bridge').length).toBeGreaterThanOrEqual(2);
      return trace;
    });

    mirrored(`${level} sends idle troopers against a hostile bridge at its tunnels`, (f) => {
      f.lake(31, 8); f.lake(32, 8);
      // Through the sim's placement path: it sets the bridge's cell, which its collapse back to lake keys on.
      const bridge = f.s.placeLavaBridge(f.cell(31, 8), f.foe);
      // A digger beside the bridge sees it; the trooper waits at home, out of its weapon's reach.
      f.add('digger', f.army, 29.5, 8.5);
      f.add('trooper', f.army, 12.5, 8.5);
      f.s.depthsVersion++;
      const trace: string[] = [];
      const sent = drive(f, level, 2400, () => bridge.dead, trace);
      expect(sent.some((i) => i.kind === 'attack' && i.target === f.g.entityId(f.team, bridge.id))).toBe(true);
      expect(bridge.dead).toBe(true);
      expect(f.s.cells[f.cell(31, 8)]).toBe(CELL.lake);
      return trace;
    });

    mirrored(`${level} undermines beside a hostile bridge when it has no troopers`, (f) => {
      f.lake(31, 8); f.lake(32, 8);
      const bridge = f.s.placeLavaBridge(f.cell(31, 8), f.foe);
      f.add('digger', f.army, 29.5, 8.5);
      f.add('sapper', f.army, 12.5, 8.5);
      f.s.depthsVersion++;
      const trace: string[] = [];
      const sent = drive(f, level, 2400, () => bridge.dead, trace);
      expect(sent.some((i) => i.kind === 'undermine')).toBe(true);
      expect(bridge.dead).toBe(true);
      expect(f.s.cells[f.cell(31, 8)]).toBe(CELL.lake);
      return trace;
    });

    mirrored(`${level} walls a Warden beside its bridge when an armed foe nears it`, (f) => {
      // Our bridge spans a one-cell lake at (31, 8); a hostile Warden waits in the tunnel beyond it, out of its weapon's
      // reach. Depths vision floods open cells only (a lake stops it; the deck carries it), so our digger sees it.
      f.lake(31, 8);
      for (let x = 32; x <= 35; x++) f.set(x, 8, CELL.tunnel);
      f.s.placeLavaBridge(f.cell(31, 8), f.army);
      f.add('warden', f.foe, 34.5, 8.5);
      f.add('digger', f.army, 30.5, 8.5);
      // One Warden for the home guard, one free for the bridge.
      const wardens = [f.add('warden', f.army, 12.5, 8.5), f.add('warden', f.army, 24.5, 8.5)];
      f.s.depthsVersion++;
      // The spotter retreats from the armed foe on its own; the first decision must already see it.
      f.s.computeVision();
      const trace: string[] = [];
      const shore = (w: Ent) => w.state === 'walled' && f.canon(w).startsWith('30.5,8.5,');
      const sent = drive(f, level, 1200, () => wardens.some(shore), trace);
      expect(sent.some((i) => i.kind === 'deploy' && wardens.some((w) => i.units.includes(f.g.entityId(f.team, w.id))))).toBe(true);
      expect(wardens.some(shore)).toBe(true);
      return trace;
    });
  }
});

/** Intent cell coordinates of canonical cell (x, y) in `f`'s frame. */
function cellXY(f: Fixture, x: number, y: number): { x: number; y: number } {
  const c = f.cell(x, y);
  return { x: c % f.s.size, y: Math.floor(c / f.s.size) };
}
