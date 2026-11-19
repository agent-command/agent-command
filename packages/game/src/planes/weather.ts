/**
 * Sky weather: natural storm orbits on public schedules, seeded storms, drifting fog and jet lanes, plus the exact
 * membership predicates (storm masks, strength, wind) the sim, bots and clients share. Allocation-free per tick.
 * Natural weather comes in orbits of the map's `sides` (C2: point-mirrored pairs; C4: four quarter turns): one
 * canonical member is drawn and evaluated, the others are its exact rotations (DESIGN §15.8).
 */
import { footprintDistance } from '../rules/stats.ts';
import { TICK_RATE } from '../rules/vocabulary.ts';
import type { Econ, JetLane, NaturalStorm, SeededStorm, SeedWarning, Weather, WeatherCell } from '../rules/contract.ts';
import { Rng } from '../util/rng.ts';
import { mix, mixBool } from '../sim/hash.ts';
import { FOG_DIRECTION, FOG_PHASE, LANE_GRID, PAIR_SALTS, SEEDED_STORMS, STORM_EVADE_TURNS, STORM_SETS, WIND_MIN_SPEED } from '../sim/constants.ts';
export type { NaturalStorm } from '../rules/contract.ts';
import { QUARTER_TURN, canonX, canonY, rotVX, rotVY, rotX, rotY, sectorOf } from '../util/teams.ts';
import { dmath } from '../util/fdlibm.js';
import { GEOM_EPS, norm, TAU } from '../util/math.ts';
import { clampPos } from '../util/grid.ts';

/**
 * A natural storm as the sim keeps it: `turns` (quarter turns) carries its orbit's canonical cell onto this one; the
 * public shape is the same (publicStorm copies it in the schema's key order).
 */
export type SkyStorm = NaturalStorm;

/** The public fields of a sim storm, in the schema's key order. */
export function publicStorm(c: NaturalStorm): NaturalStorm {
  return {
    id: c.id, x: c.x, y: c.y, radius: c.radius, maxRadius: c.maxRadius, strength: c.strength, stage: c.stage,
    originX: c.originX, originY: c.originY, dx: c.dx, dy: c.dy, turns: c.turns,
    start: c.start, grown: c.grown, breaking: c.breaking, end: c.end,
  };
}

/**
 * One fog bank per slot on the same circular path. Bank r is bank 0 turned r slots (positions: see moveFog), and its
 * public path says so: the canonical phase plus `turns`.
 */
function fogBanks(radius: number, track: number, period: number, phase: number, direction: number, size: number, sides: number): WeatherCell[] {
  if (radius === 0) return [];
  const speed = direction * 2 * Math.PI * TICK_RATE / period;
  const step = 4 / sides;
  return Array.from({ length: sides }, (_, r) => ({ x: 0, y: 0, radius, path: { cx: size / 2, cy: size / 2, radius: track, phase, speed, turns: r * step } }));
}

/** Jet lane 0 (row `y`, blowing +x) turned `turns` quarter turns; `+ 0` keeps a negated zero out of the direction. */
function lane(turns: number, y: number, width: number, size: number): JetLane {
  return {
    x1: rotX(turns, 0, y, size), y1: rotY(turns, 0, y, size), x2: rotX(turns, size, y, size), y2: rotY(turns, size, y, size),
    width, dx: rotVX(turns, 1, 0) + 0, dy: rotVY(turns, 1, 0) + 0,
  };
}

/** Distance of (x, y) from a lane's centre line (lanes are rows or columns). */
function laneDistance(l: JetLane, x: number, y: number): number {
  return l.dy === 0 ? Math.abs(y - l.y1) : Math.abs(x - l.x1);
}

export interface StormSample { x: number; y: number; radius: number; strength: number; stage: NaturalStorm['stage'] }

/**
 * Exact public lifecycle interpolation, in frame `frame` (0..3): the canonical point is evaluated once, then turned
 * by the storm's `turns` less the frame, without rounding twice.
 */
export function sampleStorm(c: NaturalStorm, tick: number, out: StormSample, frame = 0, size: number): void {
  const k = (c.turns - frame) & 3;
  const age = Math.max(0, Math.min(c.end, tick) - c.start);
  const x = c.originX + c.dx * age;
  const y = c.originY + c.dy * age;
  out.x = rotX(k, x, y, size);
  out.y = rotY(k, x, y, size);
  out.stage = tick < c.start ? 'forecast' : tick < c.grown ? 'forming' : tick < c.breaking ? 'mature' : 'breaking';
  out.strength = tick < c.start || tick >= c.end ? 0 : tick < c.grown
    ? (tick - c.start) / (c.grown - c.start) : tick < c.breaking ? 1 : (c.end - tick) / (c.end - c.breaking);
  out.radius = c.maxRadius * out.strength;
}

function cell(turns: number): SkyStorm {
  return { id: 0, x: 0, y: 0, radius: 0, maxRadius: 0, strength: 0, stage: 'forecast', originX: 0, originY: 0, dx: 0, dy: 0, turns, start: 0, grown: 0, breaking: 0, end: 0 };
}

/** Fixed pools and per-orbit random streams; no weather tick or predicate allocates. */
export class SkyWeather {
  readonly data: Weather;
  readonly mask: Uint32Array;
  readonly size: number;
  /** map slots (2 | 4): members per natural orbit, fog banks and jet lanes */
  readonly sides: number;
  private readonly half: number;
  private readonly slotStep: number;
  /** Invalidates entity membership caches even when weather changes twice within one sim tick. */
  version = 0;
  private readonly seedPool: SeededStorm[] = Array.from({ length: SEEDED_STORMS }, () => ({ x: 0, y: 0, radius: 0, until: 0 }));
  private readonly seededLists: SeededStorm[][] = Array.from({ length: SEEDED_STORMS + 1 }, (_, count) => this.seedPool.slice(0, count));
  /** Army that seeded storm i (index-aligned with data.seeded); sim-internal, never published. */
  private readonly seedOwner = new Int8Array(SEEDED_STORMS);
  private readonly warnPool: SeedWarning[] = Array.from({ length: SEEDED_STORMS }, () => ({ x: 0, y: 0, radius: 0, from: 0 }));
  private readonly warnLists: SeedWarning[][] = Array.from({ length: SEEDED_STORMS + 1 }, (_, count) => this.warnPool.slice(0, count));
  /** Natural storms in orbits (orbit i: storms i·sides + r, r = 0..sides−1; r = 0 is the canonical member). */
  private readonly natural: SkyStorm[];
  /**
   * The storm list for every subset of orbits (bit i: orbit i), built once: a whole orbit is active or announced
   * together, so a tick only swaps the list reference.
   */
  private readonly lists: SkyStorm[][];
  /** First storm-mask bit of the seeded storms (above every natural storm's list position). */
  private readonly seedBit: number;
  /** Every fog bank and jet lane, one per slot. */
  private readonly fog: WeatherCell[];
  private readonly lanes: JetLane[];
  /** Dedicated stream state is public so Sim.clone can restore its class prototypes without re-seeding. */
  readonly random: Rng[];
  private readonly warning = new Float64Array(STORM_SETS);
  private readonly cycles = new Uint32Array(STORM_SETS);
  private readonly econ: Econ;
  private readonly spires: readonly { readonly x: number; readonly y: number }[];
  private readonly beam: number;

  /** `spires`: every Spire centre; `sides`: the map's slots (2 | 4). */
  constructor(econ: Econ, seed: number, spires: readonly { readonly x: number; readonly y: number }[], beam: number, size: number, sides: number) {
    this.size = size;
    this.half = size / 2;
    this.sides = sides;
    this.slotStep = 4 / sides;
    this.mask = new Uint32Array(size * size);
    this.econ = econ;
    this.spires = spires;
    this.beam = beam;
    this.seedBit = STORM_SETS * sides;
    this.natural = Array.from({ length: STORM_SETS * sides }, (_, i) => cell((i % sides) * this.slotStep));
    this.lists = Array.from({ length: 1 << STORM_SETS }, (_, bits) => this.natural.filter((_, i) => bits & (1 << Math.floor(i / sides))));
    // A dedicated stream per orbit: changing other random systems or the orbit count cannot shift an existing orbit.
    this.random = PAIR_SALTS.map((salt) => new Rng(seed ^ salt));
    // On a binary grid, so every turned lane's row or column (size - y, …) and every unit's distance to any lane are
    // exact: a decimal offset would put the lanes a rounding apart and let a unit and its twin disagree at a lane edge.
    const y = this.half - Math.round(econ.jetOffset * LANE_GRID) / LANE_GRID;
    this.lanes = econ.jetWidth === 0 ? [] : Array.from({ length: sides }, (_, r) => lane(r * this.slotStep, y, econ.jetWidth, size));
    this.fog = fogBanks(econ.fogRadius, econ.fogPathRadius, econ.fogPeriod, FOG_PHASE, FOG_DIRECTION, size, sides);
    this.data = {
      storms: this.lists[0]!, forecast: this.lists[0]!,
      fog: this.fog,
      jets: this.lanes,
      seeded: this.seededLists[0]!,
      seedWarnings: this.warnLists[0]!,
    };
    for (let i = 0; i < econ.stormSets; i++) this.schedule(i, i * (econ.stormGrow + Math.min(econ.stormLifetimeMin, econ.stormLifetimeMax) + econ.stormBreak) / econ.stormSets);
    this.update(0);
  }

  private duration(rng: Rng, a: number, b: number): number {
    return Math.floor(rng.range(Math.min(a, b), Math.max(a, b) + 1));
  }

  /**
   * Clear of every Spire's beam, which reaches from the footprint edge (the Spires are symmetric, so the canonical
   * site's rotations are clear too).
   */
  private safe(x: number, y: number, radius: number): boolean {
    const reach = this.beam + radius;
    for (const p of this.spires) if (!(footprintDistance('spire', p.x, p.y, x, y) > reach)) return false;
    return true;
  }

  /** The lane nearest (x, y) (ties: the lower lane index). */
  private nearestLane(x: number, y: number): JetLane {
    let best = this.lanes[0]!;
    let distance = Infinity;
    for (const l of this.lanes) {
      const d = laneDistance(l, x, y);
      if (d >= distance) continue;
      distance = d;
      best = l;
    }
    return best;
  }

  private schedule(index: number, warning: number): void {
    const e = this.econ, rng = this.random[index]!, a = this.natural[index * this.sides]!;
    const oldX = a.originX, oldY = a.originY;
    a.maxRadius = e.stormRadius > 0 ? rng.range(Math.min(e.stormMinRadius, e.stormRadius), e.stormRadius) : 0;
    this.warning[index] = Math.floor(warning);
    a.start = this.warning[index]! + this.duration(rng, e.stormForecastMin, e.stormForecastMax);
    a.grown = a.start + e.stormGrow;
    a.breaking = a.grown + this.duration(rng, e.stormLifetimeMin, e.stormLifetimeMax);
    a.end = a.breaking + e.stormBreak;
    a.id = (this.cycles[index]!++ * STORM_SETS + index) * this.sides;
    let found = false;
    // Bounded site sampling; the exhaustive fallback below handles extreme custom rule combinations.
    for (let attempt = 0; attempt < this.size * this.size; attempt++) {
      const angle = rng.range(0, TAU);
      const r = rng.range(Math.min(e.stormSiteMinRadius, e.stormSiteMaxRadius), Math.max(e.stormSiteMinRadius, e.stormSiteMaxRadius));
      let x = Math.max(0, Math.min(this.size, this.half + dmath.cos(angle) * r));
      let y = Math.max(0, Math.min(this.size, this.half + dmath.sin(angle) * r));
      if (this.lanes.length) {
        // Pulled toward a lane along its normal: on C2 maps the lane on the site's side of the centre row (exact
        // comparisons, no distance rounding at the row), else the nearest lane.
        const l = this.sides === 2 ? (y < this.half ? this.lanes[0]! : this.lanes[1]!) : this.nearestLane(x, y);
        if (l.dy === 0) y += (l.y1 - y) * e.stormSiteLaneBias;
        else x += (l.x1 - x) * e.stormSiteLaneBias;
      }
      // Not the previous cycle's site again (the first cycle has none).
      if (!this.safe(x, y, a.maxRadius) || (x === oldX && y === oldY && a.id >= STORM_SETS * this.sides)) continue;
      a.originX = x; a.originY = y; found = true; break;
    }
    if (!found) {
      for (let y = 0; y < this.size && !found; y++) for (let x = 0; x < this.size; x++) {
        if (!this.safe(x + 0.5, y + 0.5, a.maxRadius) || (x + 0.5 === oldX && y + 0.5 === oldY)) continue;
        a.originX = x + 0.5; a.originY = y + 0.5; found = true; break;
      }
    }
    // If custom beam/radius rules leave no legal site, no illegal storm is announced or formed.
    if (!found) a.maxRadius = 0;
    a.dx = a.dy = 0;
    if (this.lanes.length) {
      // Drift with the nearest lane.
      const l = this.nearestLane(a.originX, a.originY);
      a.dx = l.dx * e.stormDrift / TICK_RATE;
      a.dy = l.dy * e.stormDrift / TICK_RATE;
    }
    // Keep the announced linear drift on-map without a hidden bounce or position clamp.
    const lifetime = a.end - a.start;
    a.dx = Math.max(-a.originX / lifetime, Math.min((this.size - a.originX) / lifetime, a.dx));
    a.dy = Math.max(-a.originY / lifetime, Math.min((this.size - a.originY) / lifetime, a.dy));
    // The other members share the canonical cell; sampleStorm turns it by their `turns`.
    for (let r = 1; r < this.sides; r++) {
      const b = this.natural[index * this.sides + r]!;
      b.id = a.id + r;
      b.originX = a.originX; b.originY = a.originY; b.dx = a.dx; b.dy = a.dy;
      b.maxRadius = a.maxRadius; b.start = a.start; b.grown = a.grown; b.breaking = a.breaking; b.end = a.end;
    }
  }

  update(tick: number): void {
    this.version++;
    let active = 0, forecast = 0;
    if (this.econ.stormRadius > 0) for (let i = 0; i < this.econ.stormSets; i++) {
      const a = this.natural[i * this.sides]!;
      while (tick >= a.end) {
        const calm = this.duration(this.random[i]!, this.econ.stormCalmMin, this.econ.stormCalmMax);
        this.schedule(i, a.end + calm);
      }
      for (let r = 0; r < this.sides; r++) {
        const c = this.natural[i * this.sides + r]!;
        sampleStorm(c, tick, c, 0, this.size);
      }
      if (a.maxRadius <= 0) continue;
      if (tick >= a.start) active |= 1 << i;
      else if (tick >= this.warning[i]!) forecast |= 1 << i;
    }
    this.data.storms = this.lists[active]!;
    this.data.forecast = this.lists[forecast]!;
    this.moveFog(tick);
  }

  /** Bank 0 evaluates its path; every other bank is its exact turn. */
  private moveFog(tick: number): void {
    const banks = this.fog;
    if (banks.length === 0) return;
    const a = banks[0]!, p = a.path;
    const angle = p.phase + tick / TICK_RATE * p.speed;
    a.x = p.cx + dmath.cos(angle) * p.radius;
    a.y = p.cy + dmath.sin(angle) * p.radius;
    for (let r = 1; r < banks.length; r++) {
      const k = r * this.slotStep;
      const b = banks[r]!;
      b.x = rotX(k, a.x, a.y, this.size);
      b.y = rotY(k, a.x, a.y, this.size);
    }
  }

  /** Parent calls once per active seeded storm (`owner`: the seeding army), then finishSeeds; the pool covers every island slot. */
  seed(index: number, x: number, y: number, radius: number, until: number, owner: number): void {
    this.version++;
    const c = this.seedPool[index]!;
    c.x = x; c.y = y; c.radius = radius; c.until = until;
    this.seedOwner[index] = owner;
  }
  /** Parent calls once per telegraphed seeded storm (no effect until `from`). */
  warn(index: number, x: number, y: number, radius: number, from: number): void {
    const c = this.warnPool[index]!;
    c.x = x; c.y = y; c.radius = radius; c.from = from;
  }
  finishSeeds(count: number, warnings: number): void {
    this.version++;
    this.data.seeded = this.seededLists[count]!;
    this.data.seedWarnings = this.warnLists[warnings]!;
  }

  /**
   * Storm damage factor at (x, y) for an aircraft whose alliance is `friends` (bit a: army a is not hostile): natural
   * storms by strength, a seeded storm 1, or `own` if the aircraft's alliance seeded it. Overlaps never stack.
   */
  harmAt(x: number, y: number, friends: number, own: number): number {
    let harm = 0;
    for (const c of this.data.storms) if (inside(c, x, y, this.half)) harm = Math.max(harm, c.strength);
    for (let i = 0; i < this.data.seeded.length; i++) {
      if (inside(this.data.seeded[i]!, x, y, this.half)) harm = Math.max(harm, friends & (1 << this.seedOwner[i]!) ? own : 1);
    }
    return harm;
  }

  /**
   * Storm evade: the nearest point `margin` tiles past the edge of a storm that harms an aircraft of alliance
   * `friends` (harmAt > 0) holding (x, y), straight out from that storm's centre or turned by STORM_EVADE_TURNS,
   * clear of every harmful storm. Computed in frame `frame` (the aircraft owner's: rotated twins pick rotated points;
   * ties go to the smaller frame x, then y). Writes `out` (world) and returns false when no harmful storm holds the
   * point or no candidate is clear.
   */
  evadePoint(x: number, y: number, friends: number, own: number, margin: number, frame: number, out: { x: number; y: number }): boolean {
    const size = this.size;
    const ux = canonX(frame, x, y, size), uy = canonY(frame, x, y, size);
    const natural = this.data.storms.length;
    let gap = Infinity, bx = 0, by = 0;
    for (let i = 0; i < natural + this.data.seeded.length; i++) {
      const c = i < natural ? this.data.storms[i]! : this.data.seeded[i - natural]!;
      if (i >= natural && (friends & (1 << this.seedOwner[i - natural]!) ? own : 1) <= 0) continue;
      if (!inside(c, x, y, this.half)) continue;
      const cx = canonX(frame, c.x, c.y, size), cy = canonY(frame, c.x, c.y, size);
      const d = norm(ux - cx, uy - cy);
      // Dead centre: out toward the owner's own corner, (−1, −1) in its frame.
      const nx = d > GEOM_EPS ? (ux - cx) / d : -Math.SQRT1_2, ny = d > GEOM_EPS ? (uy - cy) / d : -Math.SQRT1_2;
      const reach = c.radius + margin;
      for (let t = 0; t < STORM_EVADE_TURNS.length; t++) {
        const turn = STORM_EVADE_TURNS[t]!, cos = turn[0], sin = turn[1];
        const px = clampPos(cx + (nx * cos - ny * sin) * reach, size), py = clampPos(cy + (nx * sin + ny * cos) * reach, size);
        const g = norm(px - ux, py - uy);
        if (g > gap || (g === gap && (px > bx || (px === bx && py >= by)))) continue;
        if (this.harmAt(rotX(frame, px, py, size), rotY(frame, px, py, size), friends, own) > 0) continue;
        gap = g; bx = px; by = py;
      }
    }
    if (gap === Infinity) return false;
    out.x = rotX(frame, bx, by, size);
    out.y = rotY(frame, bx, by, size);
    return true;
  }

  stormMask(x: number, y: number): number {
    let mask = 0;
    for (let i = 0; i < this.data.storms.length; i++) if (inside(this.data.storms[i]!, x, y, this.half)) mask |= 1 << i;
    for (let i = 0; i < this.data.seeded.length; i++) if (inside(this.data.seeded[i]!, x, y, this.half)) mask |= 1 << (i + this.seedBit);
    return mask;
  }

  /** Overlaps never stack; seeded storms retain their full existing effect. */
  strengthAt(x: number, y: number): number {
    let strength = 0;
    for (const c of this.data.storms) if (inside(c, x, y, this.half)) strength = Math.max(strength, c.strength);
    for (const c of this.data.seeded) if (inside(c, x, y, this.half)) return 1;
    return strength;
  }
  /** Mix future-determining lifecycle state into Sim.hash; derived masks, cache versions and static rotations are excluded. */
  mixHash(): void {
    for (let i = 0; i < this.random.length; i++) {
      mix(this.random[i]!.state);
      mix(this.warning[i]!);
      mix(this.cycles[i]!);
    }
    for (const c of this.natural) {
      mix(c.id);
      mix(c.originX); mix(c.originY);
      mix(c.dx); mix(c.dy); mix(c.maxRadius);
      mix(c.start); mix(c.grown); mix(c.breaking); mix(c.end);
      // A half turn is all a C2 storm can have (the hash of two-army matches is unchanged); other turns are static.
      mixBool(c.turns === 2);
    }
    mix(this.data.seeded.length);
    for (const c of this.data.seeded) {
      mix(c.x); mix(c.y); mix(c.radius); mix(c.until);
    }
    mix(this.data.seedWarnings.length);
    for (const c of this.data.seedWarnings) {
      mix(c.x); mix(c.y); mix(c.radius); mix(c.from);
    }
  }


  refreshMask(): void {
    this.mask.fill(0);
    for (let i = 0; i < this.data.storms.length; i++) this.stampMask(this.data.storms[i]!, 1 << i);
    for (let i = 0; i < this.data.seeded.length; i++) this.stampMask(this.data.seeded[i]!, 1 << (i + this.seedBit));
  }

  private stampMask(c: { x: number; y: number; radius: number }, bit: number): void {
    if (c.radius <= 0) return;
    // Conservative bounds only: inside() remains the exact, centre-relative boundary predicate.
    const x0 = Math.max(0, Math.floor(c.x - c.radius) - 1);
    const x1 = Math.min(this.size - 1, Math.ceil(c.x + c.radius) + 1);
    const y0 = Math.max(0, Math.floor(c.y - c.radius) - 1);
    const y1 = Math.min(this.size - 1, Math.ceil(c.y + c.radius) + 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (inside(c, x + 0.5, y + 0.5, this.half)) this.mask[y * this.size + x]! |= bit;
    }
  }
  fogAt(x: number, y: number): boolean {
    for (const c of this.fog) if (inside(c, x, y, this.half)) return true;
    return false;
  }

  /**
   * Heading, not allegiance, decides wind. Holding station is neutral. Every lane covering the point applies, so where
   * turned lanes overlap (extreme offset/width rules) all multiply: picking the first lane would give a unit and its
   * twin different lanes. The factors multiply in lane order from the point's sector, so a turned unit multiplies the
   * turned lanes' factors in the same order (exact; two factors commute anyway).
   */
  windAt(x: number, y: number, dx: number, dy: number): number {
    const len = norm(dx, dy);
    if (len < WIND_MIN_SPEED) return 1;
    let wind = 1;
    const n = this.lanes.length;
    const first = n === 0 ? 0 : sectorOf(x, y, this.size, this.sides);
    for (let j = 0; j < n; j++) {
      const l = this.lanes[(first + j) % n]!;
      if (laneDistance(l, x, y) > l.width) continue;
      const c = (dx * l.dx + dy * l.dy) / len;
      wind *= c >= 0 ? 1 + (this.econ.jetWith - 1) * c : 1 + (1 - this.econ.jetAgainst) * c;
    }
    return wind;
  }
}

/** Fog-safe membership of current weather; forecast clouds have no gameplay effects. */
export function weatherStormAt(weather: Pick<Weather, 'storms' | 'seeded'>, x: number, y: number, size: number): boolean {
  const half = size / 2;
  for (const c of weather.storms) if (inside(c, x, y, half)) return true;
  for (const c of weather.seeded) if (inside(c, x, y, half)) return true;
  return false;
}

function inside(c: { x: number; y: number; radius: number }, x: number, y: number, half: number): boolean {
  const dx = (x - half) - (c.x - half), dy = (y - half) - (c.y - half);
  return c.radius > 0 && dx * dx + dy * dy <= c.radius * c.radius;
}
