/**
 * Scripted crowd-motion scenarios (no full matches): large Orbit warships and Surface units ordered into piles,
 * past the derelict hull, onto a target beside a parked fleet, through a choke and into a crowded rally. Each runs in
 * one army's frame on its own game (every other unit removed), so the same scenario run for every army of a C2 or C4
 * map must give exactly rotated trajectories. Metrics: jitter (per-axis sign flips of the per-tick step, per unit
 * second), overlap depth between bodies, time to arrive, units that never settle and units stuck short of their goal.
 */
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import { SURFACE, TICK_RATE, toTicks, type MatchOptions, type Plane, type UnitKind } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';
import { canonX, canonY, rotCell, rotX, rotY } from '../src/util/teams.ts';

/** A step shorter than this (tiles) is standing still for the jitter and settle metrics. */
const STILL = 1e-4;
/** Steps at least this long (tiles/tick, 0.2 tiles/s) count as travelling for the heading metrics. */
const CRUISE = 0.01;
/** A heading change below this (rad/tick) is straight ahead; above it, a change of sign is a wiggle. */
const WIGGLE = 0.004;
/** Scenario coordinates are laid out around this point (the centre of a 48-tile map) and shifted onto the match's. */
const REFERENCE_CENTRE = 24;

/** Scenario coordinates: army frame, around REFERENCE_CENTRE. */
export interface Ctx {
  g: AgentCommandGame;
  army: number;
  /** Shift (tiles) from scenario coordinates to the match's army frame. */
  off: number;
  add(kind: UnitKind, x: number, y: number, side?: number): Ent;
  move(units: readonly Ent[], x: number, y: number, extra?: Record<string, unknown>): void;
  attack(units: readonly Ent[], target: Ent): void;
  /** Block surface cell (cx, cy). */
  wall(cx: number, cy: number): void;
  /** The derelict hull's outer radius (tiles; 0 without the ruin): ruin scenarios lay their route out from it. */
  hull: number;
  /** Radius (tiles) of the corridor's middle, between the ring and the hull (0 without the ruin). */
  corridor: number;
}

export interface Scenario {
  name: string;
  plane: Plane;
  seconds: number;
  /** Keep the derelict ruin (scaled to the map, it fills the centre); the other scenarios switch it off. */
  ruin?: boolean;
  /** Build the scenario at tick 0; returns the units measured. `later` (if any) runs at `laterAt` seconds. */
  build(c: Ctx): Ent[];
  later?: { at: number; run(c: Ctx, units: Ent[]): Ent[] };
  /** Arrived: order done (default), or the custom test (attackers in range and still). */
  arrived?(c: Ctx, e: Ent): boolean;
}

export interface Metrics {
  /** Mean per-axis step sign flips per unit second over the run. */
  flips: number;
  /** Mean steps per unit second turning more than a right angle from the unit's last step (rocking, backing up). */
  reversals: number;
  /** Mean absolute heading change (rad/tick) between consecutive travelling steps, and the largest single one. */
  turn: number;
  turnMax: number;
  /** Turns that swing the other way from the last real turn, per unit second (weaving, jerking along a wall). */
  wiggle: number;
  /** Worst single unit's flips per second while it was moving. */
  flipsMax: number;
  /** Deepest pairwise body overlap (tiles) at any tick, and at the end. */
  overlap: number;
  overlapEnd: number;
  /** Longest run (seconds) any pair stayed overlapped deeper than 0.1 tiles. */
  overlapHold: number;
  /** Seconds until every unit arrived (Infinity: some never did). */
  arrive: number;
  /** Seconds until the last step longer than STILL. */
  settle: number;
  /** Units still moving over the last second. */
  restless: number;
  /** Units that never arrived. */
  stuck: number;
  /** Canonical (army-frame) final positions, for the mirror check. */
  finals: [number, number][];
}

/** A game with only Spires, islands (and the derelict ruin when `ruin`) left; four_corners when `sides` is 4. */
export function arenaGame(sides: 2 | 4, ruin = true, seed = 19): AgentCommandGame {
  const options: MatchOptions = {
    terrain: 'open',
    spire: { dmg: 0 },
    orbit: { maxAsteroids: 0, stationPdDamage: 0, derelictRadiation: 0, derelictEnabled: ruin },
  };
  const g = sides === 4 ? new AgentCommandGame(seed, { ...options, map: { name: 'four_corners' } }) : createGame({ seed, options });
  for (const e of g.sim.ents) if (e.unit) e.hp = 0;
  g.step();
  return g;
}

/** Run `s` for army `army` of a C2 or C4 arena; `onTick` sees every tick (diagnostics). */
export function runScenario(s: Scenario, sides: 2 | 4, army: number, onTick?: (tick: number, units: readonly Ent[], sim: AgentCommandGame['sim']) => void): Metrics {
  const g = arenaGame(sides, s.ruin === true);
  const sim = g.sim;
  const k = sim.armyFrame[army]!;
  const size = sim.size;
  const team = sim.armyIds[army]!;
  const role = s.plane;
  // Scenarios are laid out around REFERENCE_CENTRE and shifted onto this match's centre (and its derelict).
  const off = size / 2 - REFERENCE_CENTRE;
  const wx = (x: number, y: number): number => rotX(k, x + off, y + off, size);
  const wy = (x: number, y: number): number => rotY(k, x + off, y + off, size);
  const c: Ctx = {
    g,
    army,
    off,
    hull: sim.derelict?.hullOuter ?? 0,
    corridor: sim.derelict ? (sim.derelict.ringOuter + sim.derelict.hullInner) / 2 : 0,
    add(kind, x, y, side = army) {
      const e = sim.add(kind, side, s.plane, wx(x, y), wy(x, y));
      e.stance = 'hold';
      return e;
    },
    move(units, x, y, extra = {}) {
      const r = g.apply({ team, role }, { kind: 'move', units: units.map((e) => g.entityId(team, e.id)), x: wx(x, y), y: wy(x, y), ...extra } as never);
      if (!r.ok) throw new Error(`${s.name}: move failed ${JSON.stringify(r)}`);
    },
    attack(units, target) {
      const r = g.apply({ team, role }, { kind: 'attack', units: units.map((e) => g.entityId(team, e.id)), target: g.entityId(team, target.id) } as never);
      if (!r.ok) throw new Error(`${s.name}: attack failed ${JSON.stringify(r)}`);
    },
    wall(cx, cy) {
      const cell = rotCell(k, (cy + off) * size + cx + off, size);
      sim.terrain[cell] = SURFACE.cliff;
      sim.block[cell] = 1;
    },
  };
  if (s.plane === 'surface') {
    sim.terrain.fill(SURFACE.ground);
    sim.block.fill(0);
    sim.surfaceCost.fill(1);
  }
  let units = s.build(c);
  if (s.plane === 'surface') {
    for (const a of sim.allArmies) sim.refreshSurfaceFootprints(a);
    sim.holesVersion++;
  }
  const ticks = toTicks(s.seconds);
  /** Last position, last nonzero step signs per axis, last nonzero step, and the last real turn (rad, signed). */
  const prev = new Map<number, { x: number; y: number; sx: number; sy: number; dx: number; dy: number; turn: number }>();
  const flips = new Map<number, number>();
  const reversals = new Map<number, number>();
  const movingTicks = new Map<number, number>();
  let turnSum = 0;
  let turnTicks = 0;
  let turnMax = 0;
  let wiggles = 0;
  const arrivedAt = new Map<number, number>();
  const lastMove = new Map<number, number>();
  const holds = new Map<string, number>();
  let overlap = -Infinity;
  let overlapHold = 0;
  let laterDone = !s.later;
  let start = 0;
  const arrived = s.arrived ?? ((_c: Ctx, e: Ent) => e.order.k === 'none');
  for (let t = 1; t <= ticks; t++) {
    if (!laterDone && t >= toTicks(s.later!.at)) {
      units = s.later!.run(c, units);
      laterDone = true;
      start = t;
      arrivedAt.clear();
    }
    for (const e of units) if (!prev.has(e.id)) prev.set(e.id, { x: e.x, y: e.y, sx: 0, sy: 0, dx: 0, dy: 0, turn: 0 });
    g.step();
    onTick?.(t, units, sim);
    for (const e of units) {
      const p = prev.get(e.id)!;
      const dx = e.dead ? 0 : e.x - p.x;
      const dy = e.dead ? 0 : e.y - p.y;
      const sx = Math.abs(dx) > STILL ? Math.sign(dx) : 0;
      const sy = Math.abs(dy) > STILL ? Math.sign(dy) : 0;
      let f = 0;
      if (sx && p.sx && sx !== p.sx) f++;
      if (sy && p.sy && sy !== p.sy) f++;
      flips.set(e.id, (flips.get(e.id) ?? 0) + f);
      const moving = sx !== 0 || sy !== 0;
      // A step turning more than a right angle from the last one: the unit backs up or rocks in place.
      if (moving && dx * p.dx + dy * p.dy < 0) reversals.set(e.id, (reversals.get(e.id) ?? 0) + 1);
      if (moving) {
        movingTicks.set(e.id, (movingTicks.get(e.id) ?? 0) + 1);
        lastMove.set(e.id, t);
      }
      // Heading change between consecutive travelling steps (both at least CRUISE tiles): smooth curves turn a little
      // the same way every tick; a jerky unit turns back and forth (wiggle).
      let turn = p.turn;
      if (Math.hypot(dx, dy) >= CRUISE && Math.hypot(p.dx, p.dy) >= CRUISE) {
        const dTheta = Math.atan2(p.dx * dy - p.dy * dx, p.dx * dx + p.dy * dy);
        turnSum += Math.abs(dTheta);
        turnTicks++;
        turnMax = Math.max(turnMax, Math.abs(dTheta));
        if (Math.abs(dTheta) > WIGGLE && Math.abs(p.turn) > WIGGLE && Math.sign(dTheta) !== Math.sign(p.turn)) wiggles++;
        turn = Math.abs(dTheta) > WIGGLE ? dTheta : p.turn;
      }
      prev.set(e.id, { x: e.x, y: e.y, sx: sx || p.sx, sy: sy || p.sy, dx: moving ? dx : p.dx, dy: moving ? dy : p.dy, turn });
      if (!arrivedAt.has(e.id) && !e.dead && t > start && arrived(c, e)) arrivedAt.set(e.id, t);
      if (arrivedAt.has(e.id) && !arrived(c, e)) arrivedAt.delete(e.id);
    }
    for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!;
      const b = units[j]!;
      if (a.dead || b.dead) continue;
      const o = a.radius + b.radius - Math.hypot(a.x - b.x, a.y - b.y);
      overlap = Math.max(overlap, o);
      const key = `${a.id}:${b.id}`;
      if (o > 0.1) {
        const h = (holds.get(key) ?? 0) + 1;
        holds.set(key, h);
        overlapHold = Math.max(overlapHold, h / TICK_RATE);
      } else holds.delete(key);
    }
  }
  let overlapEnd = -Infinity;
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    overlapEnd = Math.max(overlapEnd, units[i]!.radius + units[j]!.radius - Math.hypot(units[i]!.x - units[j]!.x, units[i]!.y - units[j]!.y));
  }
  let total = 0;
  let flipsMax = 0;
  let rev = 0;
  for (const e of units) {
    const f = flips.get(e.id) ?? 0;
    total += f;
    rev += reversals.get(e.id) ?? 0;
    const m = movingTicks.get(e.id) ?? 0;
    if (m >= TICK_RATE) flipsMax = Math.max(flipsMax, f / (m / TICK_RATE));
  }
  let arrive = 0;
  let stuck = 0;
  let settle = 0;
  let restless = 0;
  for (const e of units) {
    const a = arrivedAt.get(e.id);
    if (a === undefined) stuck++;
    else arrive = Math.max(arrive, (a - start) / TICK_RATE);
    const l = lastMove.get(e.id) ?? 0;
    settle = Math.max(settle, l / TICK_RATE);
    if (l > ticks - TICK_RATE) restless++;
  }
  return {
    flips: total / units.length / s.seconds,
    reversals: rev / units.length / s.seconds,
    turn: turnTicks ? turnSum / turnTicks : 0,
    turnMax,
    wiggle: wiggles / units.length / s.seconds,
    flipsMax,
    overlap,
    overlapEnd,
    overlapHold,
    arrive: stuck ? Infinity : arrive,
    settle,
    restless,
    stuck,
    finals: units.map((e) => [canonX(k, e.x, e.y, size), canonY(k, e.x, e.y, size)]),
  };
}

/** Rows of `n` around army-frame (x, y): columns `cols` wide, `step` apart. */
function block(c: Ctx, kind: UnitKind, n: number, x: number, y: number, cols: number, step: number, side?: number): Ent[] {
  const out: Ent[] = [];
  for (let i = 0; i < n; i++) out.push(c.add(kind, x + (i % cols) * step, y + Math.floor(i / cols) * step, side));
  return out;
}

const inRangeStill = (c: Ctx, e: Ent): boolean => {
  if (e.order.k !== 'attack') return e.order.k === 'none';
  const t = c.g.sim.alive(e.order.target);
  return !!t && c.g.sim.inRange(e, t) && e.vx === 0 && e.vy === 0;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    // One group order: the fleet's own slots.
    name: 'bastions: 6 to one point',
    plane: 'orbit',
    seconds: 40,
    build: (c) => {
      const us = block(c, 'bastion', 6, 8, 14, 3, 1.4);
      c.move(us, 14, 8);
      return us;
    },
  },
  {
    // Six single-ship orders at the same point (a player clicking each, or a bot ordering one at a time).
    name: 'bastions: 6 single orders, one point',
    plane: 'orbit',
    seconds: 40,
    build: (c) => {
      const us = block(c, 'bastion', 6, 8, 14, 3, 1.4);
      for (const e of us) c.move([e], 14, 8);
      return us;
    },
  },
  {
    // A second wave sent to the point the first already holds.
    name: 'bastions: two waves, one point',
    plane: 'orbit',
    seconds: 55,
    build: (c) => {
      const a = block(c, 'bastion', 3, 8, 14, 3, 1.4);
      c.move(a, 14, 8);
      return a;
    },
    later: {
      at: 15,
      run: (c, a) => {
        const b = block(c, 'bastion', 3, 8, 16, 3, 1.4);
        c.move(b, 14, 8);
        return [...a, ...b];
      },
    },
  },
  {
    name: 'mixed wedge past the derelict hull',
    plane: 'orbit',
    seconds: 60,
    ruin: true,
    build: (c) => {
      // Across the ruin's lower side, one tile inside the hull's outer edge: the straight line runs through the wall.
      const y = REFERENCE_CENTRE + c.hull - 1;
      const x0 = REFERENCE_CENTRE - c.hull - 4;
      const us = [...block(c, 'bastion', 2, x0, y - 1.6, 2, 1.6), ...block(c, 'lancer', 2, x0, y, 2, 1.6), ...block(c, 'tug', 2, x0, y + 1.6, 2, 1.6)];
      c.move(us, REFERENCE_CENTRE + c.hull + 4, y, { formation: 'wedge' });
      return us;
    },
  },
  {
    // Straight across the ruin: the fleet has to go round the hull, hugging its outer face for a quarter turn and more.
    name: 'fleet circling the hull',
    plane: 'orbit',
    seconds: 70,
    ruin: true,
    build: (c) => {
      const x0 = REFERENCE_CENTRE - c.hull - 5;
      const y0 = REFERENCE_CENTRE + 0.5;
      const us = [...block(c, 'bastion', 2, x0, y0 - 1.6, 2, 1.6), ...block(c, 'lancer', 2, x0, y0, 2, 1.6), ...block(c, 'tug', 2, x0, y0 + 1.6, 2, 1.6)];
      c.move(us, REFERENCE_CENTRE + c.hull + 4, y0);
      return us;
    },
  },
  {
    // In through the west breach to the corridor's north side, then out again to the east: lining up on the breach,
    // crossing it, running along the corridor and leaving by another.
    name: 'ships through the breaches',
    plane: 'orbit',
    seconds: 80,
    ruin: true,
    build: (c) => {
      const us = block(c, 'lancer', 3, REFERENCE_CENTRE - c.hull - 4, REFERENCE_CENTRE - 1.4, 1, 1.4);
      for (const e of us) c.move([e], REFERENCE_CENTRE, REFERENCE_CENTRE - c.corridor);
      return us;
    },
    later: {
      at: 35,
      run: (c, us) => {
        for (const e of us) c.move([e], REFERENCE_CENTRE + c.hull + 4, REFERENCE_CENTRE + 0.5);
        return us;
      },
    },
  },
  {
    name: 'bastions attack beside a parked fleet',
    plane: 'orbit',
    seconds: 40,
    build: (c) => {
      const sim = c.g.sim;
      const enemy = sim.allArmies[(sim.allArmies.indexOf(c.army) + sim.allArmies.length / 2) % sim.allArmies.length]!;
      const target = c.add('lancer', 30, 12, enemy);
      target.hp = target.maxHp = 1e7;
      const parked = block(c, 'lancer', 5, 26, 11, 3, 1.3);
      for (const e of parked) e.hp = e.maxHp = 1e7;
      const us = block(c, 'bastion', 6, 14, 10, 3, 1.4);
      for (const e of us) e.hp = e.maxHp = 1e7;
      // Vision refreshes every other tick: let the fleet see the target first.
      c.g.step();
      c.g.step();
      c.attack(us, target);
      return [...us, ...parked];
    },
    arrived: inRangeStill,
  },
  {
    name: 'tanks: 8 through a 2-tile choke',
    plane: 'surface',
    seconds: 45,
    build: (c) => {
      // A wall across rows 22-23 (army frame), open only at columns 23-24.
      for (let x = -c.off; x < c.g.sim.size - c.off; x++) if (x !== 23 && x !== 24) { c.wall(x, 22); c.wall(x, 23); }
      const us = block(c, 'tank', 8, 21.5, 14, 4, 1.5);
      c.move(us, 24, 32);
      return us;
    },
  },
  {
    name: 'tanks + flak into a crowded rally',
    plane: 'surface',
    seconds: 40,
    build: (c) => {
      const parked = block(c, 'tank', 8, 28, 28, 3, 1.35);
      const us = [...block(c, 'tank', 4, 14, 14, 2, 1.5), ...block(c, 'flak', 2, 14, 17, 2, 1.5)];
      c.move(us, 29.35, 29.35);
      return [...us, ...parked];
    },
  },
];

export function fmt(m: Metrics): string {
  const n = (v: number, d = 2): string => (v === Infinity ? '∞' : v.toFixed(d));
  return `flips/s ${n(m.flips, 3)} (max ${n(m.flipsMax)}) rev/s ${n(m.reversals, 3)} turn ${n(m.turn, 4)} (max ${n(m.turnMax, 3)}) wiggle/s ${n(m.wiggle, 3)} | overlap max ${n(m.overlap)} end ${n(m.overlapEnd)} hold ${n(m.overlapHold, 1)}s | arrive ${n(m.arrive, 1)}s settle ${n(m.settle, 1)}s | restless ${m.restless} stuck ${m.stuck}`;
}
