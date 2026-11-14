/**
 * The derelict ruin (DESIGN §4.4): wall collision and routing for Orbit ships, the ring push, chamber radiation and the
 * derelict core (tow, heat, cash-in, vent, meltdown, regrowth). Geometry is `rules/derelict.ts`, shared with
 * clients; the gate cycle is a pure function of the tick, so the only hashed ruin state is the core entity plus
 * `coreRegrowAt` and `coreLift`.
 */
import { footprintDistance, MAP_SIZES, TICK_RATE } from '../rules/contract.ts';
import {
  axisLateral, CHAMBER, CORRIDOR, derelictLayer, fold, folded, gatesOpen, nearestAxis, OUTSIDE, throughAperture, unfoldX, unfoldY, WALL_CLEAR,
  wallBlocks, wallHit,
} from '../rules/derelict.ts';
import { SPIRE_ALERT_EVERY } from '../sim/constants.ts';
import type { Ent } from '../sim/ent.ts';
import { recordDamage } from '../sim/recording.ts';
import type { Sim } from '../sim/sim.ts';
import { clampPos, cellOfEnt, quantize } from '../util/grid.ts';
import { isArmy, NEUTRAL, sectorOf } from '../util/teams.ts';
import { norm, sq, TAU } from '../util/math.ts';
import { dmath } from '../util/fdlibm.js';

/** A body this far (tiles) inside the approach line of an aperture has lined up and heads straight through. */
const LINE_UP = 0.6;
/** Going round a wall's circle, the body steers at the point this far (tiles) ahead on its arc (pure pursuit). */
const ARC_LOOKAHEAD = 1.5;
/** It keeps the side it goes round on until the other way is shorter by more than this (rad). */
const SIDE_HYSTERESIS = 0.2;
/** Riding the arc, the body leaves on the exit tangent once its line dips no more than this (tiles) inside its radius. */
const EXIT_SLACK = 0.02;
/** Tangential sliding: a body closer than SKIM_ENTER (tiles) to a solid face slides along it until SKIM_EXIT clear. */
const SKIM_ENTER = WALL_CLEAR / 2;
const SKIM_EXIT = WALL_CLEAR;
/** Heat at which a towed core melts down. */
const MELTDOWN = 100;

/**
 * Route scratch: the waypoint `derelictRoute` picked, whether the unit must hold there (a sealed gate), and the side it
 * goes round a wall on (±1 counter-/clockwise; 0: not going round).
 */
export const route = { x: 0, y: 0, hold: false, skirt: 0 };

/**
 * Does the segment from (ax, ay) to (bx, by) (relative to the ruin's centre) pass closer than `r` to it? Sums of
 * products only, so quarter-turned twins get exactly the same answer.
 */
function grazes(ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const sx = bx - ax;
  const sy = by - ay;
  const len2 = sx * sx + sy * sy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * sx + ay * sy) / len2)) : 0;
  const cx = ax + sx * t;
  const cy = ay + sy * t;
  return cx * cx + cy * cy < r * r;
}

/**
 * Does a body of `rad` going straight between relative points a and b clip the side of an aperture (`n` of them, `half`
 * wide, in the band from `inner` to `outer`)? wallBlocks only tests where its centre line crosses the band's middle
 * circle: a line that dips into a mouth and leaves the band again through the side never reaches the middle, so the
 * body clips the side and slides on through (out of an open gate into the chamber, where the sealing ring holds it).
 * Clear only through the opening at the inner, middle and outer circles alike. A body too wide for the opening is left
 * to wallBlocks.
 */
function clipsAperture(n: number, half: number, inner: number, outer: number, rad: number, ax: number, ay: number, bx: number, by: number): boolean {
  return half - rad - WALL_CLEAR > 0 && !throughAperture(n, half, inner, outer, rad, ax, ay, bx, by);
}

export class DerelictPlane {
  /** The live derelict core, if one has grown. */
  derelictCore(this: Sim): Ent | undefined {
    return this.coreId ? this.alive(this.coreId) : undefined;
  }

  spawnCore(this: Sim): void {
    const g = this.derelict!;
    const core = this.add('core', NEUTRAL, 'orbit', g.x, g.y);
    // The core is its own C2/C4 twin: it takes no neutral serial, so asteroid orbits keep their consecutive blocks.
    this.seqs[NEUTRAL]!--;
    core.seq = -1;
    core.hp = core.maxHp = this.econ.coreHp;
    core.vents = 0;
    core.heat = 0;
    core.state = 'idle';
    this.coreId = core.id;
    this.coreRegrowAt = -1;
    this.coreLift.at = -1;
  }

  /**
   * Waypoint toward (x, y) for an Orbit disc of radius `rad` at (x0, y0) that avoids the ruin's walls, in `route`.
   * False: the straight line is clear (steer to the point itself). A wall in the way on the body's own layer (the hull
   * from outside, the ring from the corridor) is gone round as a circular obstacle: a straight line to the tangent
   * point of the circle ARC clearance off its face, then along that arc (a carrot ARC_LOOKAHEAD tiles ahead on it),
   * leaving on the exit tangent once the straight line to the point clears the face. Hysteresis on both: `skirt`
   * (the body's side so far, ±1 counter-/clockwise, 0 if not going round) keeps it going round until the line clears
   * by half the clearance more than it took to start, and keeps its side until the other is shorter by
   * SIDE_HYSTERESIS (`route.skirt` is the new value). Through an aperture the body cuts straight in when its line
   * passes the opening, else first lines up on its axis outside the wall; a sealed ring holds it at the gate mouth
   * (`route.hold`). A fleet routes its whole formation as one disc.
   */
  derelictRoute(this: Sim, x0: number, y0: number, rad: number, x: number, y: number, skirt = 0): boolean {
    route.skirt = 0;
    const g = this.derelict;
    if (!g) return false;
    const open = gatesOpen(g, this.tick);
    const ux = x0 - g.x;
    const uy = y0 - g.y;
    const tx = x - g.x;
    const ty = y - g.y;
    const ru = Math.sqrt(ux * ux + uy * uy);
    const rt = Math.sqrt(tx * tx + ty * ty);
    const lu = derelictLayer(g, ru);
    const lt = derelictLayer(g, rt);
    // Going round on its own layer: the face its centre must keep off (outside: the hull's; corridor: the ring's). A
    // target hugging that face is reached as soon as the straight line no longer crosses the wall. Going round already
    // (skirt), the body leaves only once the line clears half the wall clearance more, or no longer dips inside the
    // circle it rides on (the exit tangent) — never past the target, never inside the face itself.
    const round = lu === lt && lu !== CHAMBER;
    const face = (lu === OUTSIDE ? g.hullOuter : g.ringOuter) + rad;
    const leave = Math.max(face, Math.min(face + WALL_CLEAR / 2, (face + rt) / 2, ru - EXIT_SLACK));
    const blocked = round && rt >= face ? grazes(ux, uy, tx, ty, skirt !== 0 ? leave : face)
      : wallBlocks(g, open, ux, uy, tx, ty, rad + WALL_CLEAR) || clipsAperture(g.breaches, g.breachWidth / 2, g.hullInner, g.hullOuter, rad, ux, uy, tx, ty)
        || (open && clipsAperture(g.gates, g.gateWidth / 2, g.ringInner, g.ringOuter, rad, ux, uy, tx, ty));
    if (!blocked) return false;
    route.hold = false;
    // Work in the unit's folded quarter; the target turns with it, the answer turns back.
    fold(ux, uy);
    const turns = folded.turns;
    const fx = folded.x;
    const fy = folded.y;
    let wx: number;
    let wy: number;
    const inHull = ru + rad > g.hullInner && ru - rad < g.hullOuter;
    if (inHull || (ru + rad > g.ringInner && ru - rad < g.ringOuter)) {
      // Inside an aperture (overlapping a band): finish crossing along its axis before turning anywhere — outward if
      // the target lies beyond the band's middle, else inward — instead of cutting the corner into its sides.
      const outer = inHull ? g.hullOuter : g.ringOuter;
      const inner = inHull ? g.hullInner : g.ringInner;
      const a = nearestAxis(inHull ? g.breaches : g.gates, fx, fy);
      const R = rt >= (inner + outer) / 2 ? outer + rad + 2 * WALL_CLEAR : inner - rad - 2 * WALL_CLEAR;
      wx = dmath.cos(a) * R;
      wy = dmath.sin(a) * R;
    } else if (round) {
      // The arc: WALL_CLEAR off the hull's face outside (widened by the pursuit chord's sag, so the body rides at the
      // clearance itself rather than just inside it), the corridor's middle inside the ruin.
      const R = lu === OUTSIDE ? face + WALL_CLEAR + sq(ARC_LOOKAHEAD) / (2 * (face + WALL_CLEAR)) : (g.ringOuter + g.hullInner) / 2;
      const a0 = dmath.atan2(fy, fx);
      // Angle to the target counter-clockwise, in [0, 2π): the shorter way round, unless the side kept so far is
      // within the hysteresis of it.
      const ftx = unfoldX(4 - turns, tx, ty);
      const fty = unfoldY(4 - turns, tx, ty);
      let ccw = dmath.atan2(fty, ftx) - a0;
      if (ccw < 0) ccw += TAU;
      const shorter = ccw <= TAU - ccw ? 1 : -1;
      const side = skirt !== 0 && skirt !== shorter && Math.abs(TAU - 2 * ccw) < 2 * SIDE_HYSTERESIS ? skirt : shorter;
      route.skirt = side;
      // The tangent point seen from outside the circle (none from on or inside it), then the carrot along the arc.
      const a = a0 + side * ((ru > R ? dmath.acos(R / ru) : 0) + ARC_LOOKAHEAD / R);
      wx = dmath.cos(a) * R;
      wy = dmath.sin(a) * R;
    } else {
      // Crossing one wall toward the target's layer: the hull from outside, the ring from the corridor or chamber.
      const hull = lu === OUTSIDE || (lu === CORRIDOR && lt === OUTSIDE);
      const n = hull ? g.breaches : g.gates;
      const half = (hull ? g.breachWidth : g.gateWidth) / 2;
      const outer = hull ? g.hullOuter : g.ringOuter;
      const inner = hull ? g.hullInner : g.ringInner;
      const inward = hull ? lu === OUTSIDE : lu === CORRIDOR;
      const a = nearestAxis(n, fx, fy);
      const cx = dmath.cos(a);
      const cy = dmath.sin(a);
      const along = fx * cx + fy * cy;
      const lined = axisLateral(n, fx, fy) + rad <= half * LINE_UP + (1 - LINE_UP) * Math.max(0, half - rad);
      const mouth = inward ? outer + rad + 2 * WALL_CLEAR : inner - rad - 2 * WALL_CLEAR;
      const through = inward ? inner - rad - 2 * WALL_CLEAR : outer + rad + 2 * WALL_CLEAR;
      if (!hull && !open) {
        // Sealed: wait at the gate mouth on this side.
        route.hold = true;
        wx = cx * mouth;
        wy = cy * mouth;
      } else if ((lined && (inward ? along <= mouth + LINE_UP : along >= mouth - LINE_UP)) || throughAperture(n, half, inner, outer, rad, fx, fy, cx * through, cy * through)) {
        // Lined up, or a straight line through the opening already: head through without turning on the mouth.
        wx = cx * through;
        wy = cy * through;
      } else {
        wx = cx * mouth;
        wy = cy * mouth;
      }
    }
    // The offset goes on the position grid before it is added: the centre plus an unquantized offset rounds in the
    // binade of the sum, which differs between twins either side of the centre, and clampPos can then land them a
    // quantum apart.
    route.x = clampPos(g.x + quantize(unfoldX(turns, wx, wy)), this.size);
    route.y = clampPos(g.y + quantize(unfoldY(turns, wx, wy)), this.size);
    return true;
  }

  /**
   * Wall collision for an Orbit step (vx, vy) of `e` (tiles/tick): a step into a wall keeps only its component along
   * the wall face (inertia along it), else it stops. Faces: the bands' circles, or an aperture's side when the body
   * already stands in it. Returns the allowed step in `route`.
   */
  derelictClip(this: Sim, e: Ent, vx: number, vy: number): void {
    route.x = vx;
    route.y = vy;
    const g = this.derelict;
    if (!g) return;
    const open = gatesOpen(g, this.tick);
    const dx = e.x - g.x;
    const dy = e.y - g.y;
    if (!wallHit(g, open, dx + vx, dy + vy, e.radius)) return;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r === 0) {
      route.x = route.y = 0;
      return;
    }
    // Body overlapping a band (standing in an aperture): its side walls are the face, so keep the radial part; else
    // the band's circle is, so keep the tangential part. Then the other one; else stop.
    const rad = e.radius;
    const inBand = (r + rad > g.ringInner && r - rad < g.ringOuter) || (r + rad > g.hullInner && r - rad < g.hullOuter);
    const nx = dx / r;
    const ny = dy / r;
    const radial = vx * nx + vy * ny;
    for (let k = 0; k < 2; k++) {
      const keepRadial = inBand === (k === 0);
      const sx = keepRadial ? nx * radial : vx - nx * radial;
      const sy = keepRadial ? ny * radial : vy - ny * radial;
      if (!wallHit(g, open, dx + sx, dy + sy, rad)) {
        route.x = sx;
        route.y = sy;
        return;
      }
    }
    route.x = route.y = 0;
  }

  /**
   * Tangential sliding along the ruin's walls, treated as exact circles (the hull's outer and inner faces, the ring's
   * outer and inner faces): a body that comes within SKIM_ENTER of the face it is nearest to, where that face is solid
   * (not an aperture it could pass), slides — its wanted velocity (vx, vy) keeps only the part along the face — until it
   * is SKIM_EXIT clear again. The two margins (hysteresis, `e.skim`) keep it from flickering between touching and free
   * every tick, which a push-out each tick would do. Result in `route`.
   */
  derelictSkim(this: Sim, e: Ent, vx: number, vy: number): void {
    route.x = vx;
    route.y = vy;
    const g = this.derelict;
    const dx = g ? e.x - g.x : 0;
    const dy = g ? e.y - g.y : 0;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (!g || r === 0) {
      e.skim = false;
      return;
    }
    // The nearest face: its clearance from the body's edge (tiles) and which way free space lies (+1: outward).
    const rad = e.radius;
    let gap: number;
    let out: number;
    let hull: boolean;
    if (r >= (g.hullInner + g.hullOuter) / 2) {
      gap = r - rad - g.hullOuter;
      out = 1;
      hull = true;
    } else if (r >= (g.ringInner + g.ringOuter) / 2) {
      const toHull = g.hullInner - rad - r;
      const toRing = r - rad - g.ringOuter;
      hull = toHull < toRing;
      gap = hull ? toHull : toRing;
      out = hull ? -1 : 1;
    } else {
      gap = g.ringInner - rad - r;
      out = -1;
      hull = false;
    }
    fold(dx, dy);
    const solid = hull
      ? axisLateral(g.breaches, folded.x, folded.y) + rad > g.breachWidth / 2
      : !gatesOpen(g, this.tick) || axisLateral(g.gates, folded.x, folded.y) + rad > g.gateWidth / 2;
    e.skim = solid && gap < (e.skim ? SKIM_EXIT : SKIM_ENTER);
    if (!e.skim) return;
    const nx = (out * dx) / r;
    const ny = (out * dy) / r;
    const into = vx * nx + vy * ny;
    if (into < 0) {
      route.x = vx - into * nx;
      route.y = vy - into * ny;
    }
  }

  /** Can Orbit fire between `e` and `t` (the ruin's walls blocking the straight line)? */
  derelictClear(this: Sim, e: Ent, t: Ent): boolean {
    const g = this.derelict;
    return !g || !wallBlocks(g, gatesOpen(g, this.tick), e.x - g.x, e.y - g.y, t.x - g.x, t.y - g.y);
  }

  /** Radiation: shields first (resetting their regen delay), then hull; Aegis pools do not cover it. */
  irradiate(this: Sim, e: Ent, amount: number): void {
    e.combatAt = this.tick;
    this.breakCloak(e);
    const absorbed = Math.min(e.shield, amount);
    e.shield -= absorbed;
    amount -= absorbed;
    if (amount <= 0) return;
    const dealt = Math.min(e.hp, amount);
    e.hp -= amount;
    e.lastHitBy = NEUTRAL;
    e.lastHitCause = 'radiation';
    e.lastHitPlane = 'orbit';
    e.lastHitKind = undefined;
    if (dealt > 0) recordDamage(this, e, dealt, NEUTRAL, 'radiation', 'orbit');
  }

  /**
   * After movement: push out whatever stands in the sealed ring (radially to the nearer side, no damage), irradiate the
   * chamber, then the core's holder, tow, heat, regrowth.
   */
  updateDerelict(this: Sim): void {
    const g = this.derelict;
    if (!g) return;
    const open = gatesOpen(g, this.tick);
    const dps = this.econ.derelictRadiation / TICK_RATE;
    const mid = (g.ringInner + g.ringOuter) / 2;
    for (const e of this.ents) {
      if (e.dead || e.plane !== 'orbit' || !e.unit || e.hangar || e.hp <= 0) continue;
      const dx = e.x - g.x;
      const dy = e.y - g.y;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (!open && r > 0 && r + e.radius > g.ringInner && r - e.radius < g.ringOuter) {
        const to = r < mid ? g.ringInner - e.radius - WALL_CLEAR : g.ringOuter + e.radius + WALL_CLEAR;
        e.x = clampPos(g.x + quantize((dx * to) / r), this.size);
        e.y = clampPos(g.y + quantize((dy * to) / r), this.size);
        const radial = (e.vx * dx + e.vy * dy) / (r * r);
        e.vx -= dx * radial;
        e.vy -= dy * radial;
        // The tow rides on the tug (no rope length): it goes to the same side of the ring, never through a wall.
        const tow = e.link ? this.alive(e.link) : undefined;
        if (tow && tow.state === 'towed' && tow.link === e.id) {
          tow.x = e.x;
          tow.y = e.y;
        }
      }
      if (dps > 0) {
        const ex = e.x - g.x;
        const ey = e.y - g.y;
        if (ex * ex + ey * ey < g.ringInner * g.ringInner) {
          this.irradiate(e, dps);
          // Own only, throttled like the Spire alarm: the owner's ships are burning in the chamber.
          const t = isArmy(e.side) ? this.armies[e.side]! : undefined;
          if (t && this.tick - t.radiationEventAt >= SPIRE_ALERT_EVERY) {
            t.radiationEventAt = this.tick;
            this.emit([e.side], 'irradiated', 'orbit', e.x, e.y, e.kind, e.side);
          }
        }
      }
    }
    const core = this.derelictCore();
    if (!core) {
      if (this.coreRegrowAt >= 0 && this.tick >= this.coreRegrowAt && this.econ.coreEnabled) {
        this.spawnCore();
        this.emit(this.allArmies, 'core_regrows', 'orbit', g.x, g.y, 'core');
      }
      return;
    }
    if (core.state === 'falling') return;
    if (core.state === 'idle') this.latchCore(core);
    const cx = core.x - g.x;
    const cy = core.y - g.y;
    const layer = derelictLayer(g, Math.sqrt(cx * cx + cy * cy));
    const tug = core.state === 'towed' ? this.alive(core.link) : undefined;
    core.heatRate = 0;
    if (layer === CHAMBER) {
      this.coreLift.at = -1;
      core.heatRate = -this.econ.coreCoolRate;
      core.heat = Math.max(0, core.heat - this.econ.coreCoolRate / TICK_RATE);
    } else if (layer === OUTSIDE) {
      // Out past the hull the core heats, towed or left there: the clock stretches with the map so a tow home fits.
      const towed = tug && isArmy(tug.side) ? tug.side : NEUTRAL;
      if (this.coreLift.at < 0 && towed !== NEUTRAL) {
        this.coreLift.at = this.tick;
        this.coreLift.x = core.x;
        this.coreLift.y = core.y;
        this.coreLift.side = towed;
        this.emit(this.allArmies, 'core_lifted', 'orbit', core.x, core.y, 'core', towed);
      }
      core.heatRate = this.econ.coreTransitHeat * dmath.pow(MAP_SIZES[0] / this.size, this.econ.coreTransitScale);
      core.heat += core.heatRate / TICK_RATE;
    }
    if (core.heat >= MELTDOWN) this.coreMeltdown(core);
  }

  /**
   * Tugs on `grapple` within grappleReach of the resting core latch after every unit has moved: tugs of two hostile
   * alliances there tie (nobody latches); else the nearest (ties: serial, then slot order from the core's sector).
   */
  latchCore(this: Sim, core: Ent): void {
    const r2 = sq(this.econ.grappleReach);
    const sector = sectorOf(core.x, core.y, this.size, this.sides);
    let best: Ent | undefined;
    let bestD = Infinity;
    for (const e of this.ents) {
      if (e.dead || e.link || e.order.k !== 'grapple' || e.order.asteroid !== core.id || !isArmy(e.side)) continue;
      const d = sq(e.x - core.x) + sq(e.y - core.y);
      if (d > r2) continue;
      if (best && this.hostile(best.side, e.side)) return;
      const ahead = (this.armySlot[e.side]! - sector + this.sides) % this.sides < (this.armySlot[best?.side ?? e.side]! - sector + this.sides) % this.sides;
      if (!best || d < bestD || (d === bestD && (e.seq < best.seq || (e.seq === best.seq && ahead)))) {
        best = e;
        bestD = d;
      }
    }
    if (!best) return;
    best.link = core.id;
    core.link = best.id;
    core.state = 'towed';
    this.clearOrder(best);
    best.state = 'towing';
  }

  /**
   * `tug` brought the core within dockRadius of its own Orbit segment: its army cashes it in once (alloy, and energy
   * straight to stock past the delivery cap; public event core_cashed) and the core is spent.
   */
  cashCore(this: Sim, core: Ent, tug: Ent): void {
    if (core.dead || core.hp <= 0 || tug.dead || tug.hp <= 0 || this.coreId !== core.id) return;
    const t = this.armies[tug.side]!;
    this.earn(tug.side, this.econ.coreRewardAlloy, this.econ.coreRewardEnergy, 'orbit');
    t.stats.coreCashed++;
    const seg = t.spire.orbit;
    this.emit(this.allArmies, 'core_cashed', 'orbit', seg.x, seg.y, 'core', tug.side);
    this.fxAdd('core_cashed', 'orbit', seg.x, seg.y, tug.side, true, { subject: 'core' });
    this.removeCore(core);
  }

  /** The core is gone (cashed in, dropped or melted): a new one grows after coreRegrowTime. */
  removeCore(this: Sim, core: Ent): void {
    // kill() may already have marked an intercepted payload dead. Identity, not HP, owns terminal cleanup.
    if (this.coreId !== core.id) return;
    const tug = this.byId.get(core.link);
    if (tug?.link === core.id) {
      tug.link = 0;
      if (tug.state === 'towing') tug.state = tug.order.k === 'move' ? 'moving' : 'idle';
      if (tug.order.k === 'vent' || tug.order.k === 'grapple') this.clearOrder(tug);
    }
    core.link = 0;
    core.dead = true;
    core.hp = 0;
    this.coreId = 0;
    this.coreLift.at = -1;
    this.coreRegrowAt = this.tick + this.econ.coreRegrowTime;
  }

  /** Heat 100 or destroyed under tow: the volatile-style Orbit blast, seen only by the groups that see it. */
  coreMeltdown(this: Sim, core: Ent): void {
    if (core.dead || this.coreId !== core.id) return;
    const by = core.hp <= 0 ? core.lastHitBy : NEUTRAL;
    let viewers = 0;
    const c = cellOfEnt(core, this.size);
    for (const army of this.allArmies) {
      if (!this.seesCell(army, 'orbit', c)) continue;
      viewers |= this.armies[army]!.group.bit;
      this.emit([army], 'core_meltdown', 'orbit', core.x, core.y, 'core');
    }
    const fx = this.fxAdd('volatile_detonation', 'orbit', core.x, core.y, NEUTRAL, false, { subject: 'core', radius: this.econ.coreMeltdownRadius });
    fx.viewers = viewers;
    const x = core.x;
    const y = core.y;
    this.removeCore(core);
    this.blastOrbit(x, y, this.econ.coreMeltdownRadius, this.econ.coreMeltdownDamage, by, 'core_meltdown', true);
  }

  /** Damage every live Orbit unit (and, with `structures`, structure) within `radius` of (x, y). */
  blastOrbit(this: Sim, x: number, y: number, radius: number, damage: number, by: number, cause: string, structures: boolean): void {
    if (damage <= 0) return;
    const r2 = radius * radius;
    for (const e of this.ents) {
      if (e.dead || e.hp <= 0 || e.plane !== 'orbit' || !(e.unit || (structures && e.structure))) continue;
      const d = e.structure ? footprintDistance(e.kind, e.x, e.y, x, y) : norm(e.x - x, e.y - y);
      if (d * d <= r2) this.damage(e, damage, by, false, cause, 'orbit', 'core');
    }
  }

  updateVent(this: Sim, e: Ent, o: { k: 'vent'; until: number }): void {
    const core = this.alive(e.link);
    if (!core || core.kind !== 'core' || core.state !== 'towed') return this.clearOrder(e);
    this.drive(e, 0, 0);
    e.state = 'towing';
    if (e.vx !== 0 || e.vy !== 0) {
      o.until = this.tick + this.econ.coreVentTicks;
      e.progress = 0;
      return;
    }
    e.progress = 1 - (o.until - this.tick) / this.econ.coreVentTicks;
    if (this.tick < o.until) return;
    // Each vent leaves more heat behind: the core's life runs out however often it is vented.
    core.vents++;
    core.heat = Math.min(MELTDOWN, core.vents * this.econ.coreVentFloor);
    this.fxAdd('core_vent', 'orbit', core.x, core.y, e.side, false, { subject: 'core', radius: this.econ.coreVentRadius });
    this.emit([e.side], 'core_vented', 'orbit', core.x, core.y, 'core', e.side);
    this.blastOrbit(core.x, core.y, this.econ.coreVentRadius, this.econ.coreVentDamage, e.side, 'core_vent', false);
    this.clearOrder(e);
  }
}
