/** Movement and steering: open-plane kinematics with ORCA avoidance, surface flow-field navigation, firing positions, fleets and body separation. */
import { footprintDistance, isAirArmor, isNeutralKind, isStatKind, isSurfaceHigh, surfaceFeature, PLANES, SURFACE, TICK_RATE } from '../rules/contract.ts';
import { hullLineClear } from '../nav/nav.ts';
import { ORCA_MAX_NEIGHBOURS, orcaBegin, orcaNeighbour, orcaOut, orcaSolve } from '../nav/orca.ts';
import { cellCentreX, cellCentreY, cellFor, cellOfEnt, clampPos, quantize } from '../util/grid.ts';
import { GEOM_EPS, norm, norm2, sq, TAU, wrapPi, ZERO_EPS } from '../util/math.ts';
import { canonCell, canonVX, canonVY, canonX, canonY, isArmy, rotCell, rotVX, rotVY, rotX, rotY } from '../util/teams.ts';
import {
  ARRIVE_APPROACH,
  ARRIVE_EPS,
  ARRIVE_SETTLE,
  AVOID_SMOOTH,
  BUCKET,
  BYPASS_TICKS,
  CONTACT,
  CROWD_ARRIVE,
  CROWD_RADII,
  DEPLOY_NONE,
  FLEET_BRAKE_SHARE,
  DEPTHS_CELL_MAX,
  DEPTHS_CELL_MIN,
  FIRING_KEY_STRIDE,
  FIRING_REACH_STEPS,
  GOAL_FIRING,
  GOAL_NONE,
  HEX_PACKING,
  MAX_BODY_RADIUS,
  MAX_PUSH,
  MAX_SLOT_RINGS,
  NAV_ARRIVED,
  NAV_BLOCKED,
  NAV_LOOKAHEAD,
  NAV_MOVING,
  NAV_REPLAN,
  type NavStep,
  NUDGE_DEEP,
  ORCA_SHARE,
  ORCA_TAU,
  PLANE_INDEX,
  PROGRESS,
  RANGE_MARGIN,
  SEP_DAMP,
  SEP_DEADBAND,
  SEP_SHARE_MOVER,
  SEP_SHARE_RESTING,
  SEP_TIE_DEGREES,
  SEP_TIE_PRIME_HI,
  SEP_TIE_PRIME_LO,
  SEP_UNIT_DEADBAND,
  SHOVE_TICKS,
  SITE_EJECT,
  SNAP_EPS,
  STALL_TICKS,
  STUCK_FRACTION,
  STUCK_TICKS,
  TURN_MIN_ACCEL,
  TURN_SPEED_SHARE,
  WAYPOINT_REACH,
} from './constants.ts';
import { Ent, type FleetMove } from './ent.ts';
import type { Sim } from './sim.ts';
import { route } from '../planes/derelict.ts';
import { gatesOpen, WALL_CLEAR, wallBlocks, wallHit } from '../rules/derelict.ts';
import { dmath } from '../util/fdlibm.js';

/** Firing spot scratch (`firingSpot`): the point an attacker steers at instead of its target. */
const spot = { x: 0, y: 0 };
/** Ring search sides for `firingSpot`: the bearing point once, then each step on the frame's +, then − side. */
const ONE_SIDE = [1] as const;
const BOTH_SIDES = [1, -1] as const;

export class SimMovement {
  /**
   * Kinematics for the open planes: the unit wants velocity (vx, vy) tiles/tick; ORCA bends that around the bodies
   * near it (see orca.ts: half the avoidance against moving units that avoid too, all of it against the rest), the
   * bend is smoothed over ticks, the velocity turns toward the result within the unit's acceleration (braking twice as
   * hard), and it moves. A step into a
   * cliff or hole keeps only the axis that stays clear; one that would still push deeper into a body waits.
   */
  drive(this: Sim, e: Ent, vx: number, vy: number): void {
    this.steered = true;
    const pref = norm(vx, vy);
    if (e.bypass > 0) {
      // Detour: boxed in toward its goal (a dead end between bodies), the unit goes around a side for a while. An
      // Orbit ship cannot side-step (with its inertia and turn rate a detour is a wide loop back), and pressing on
      // only rocks it against the bodies in the way: it holds still instead, until it gets a way or a new slot.
      e.bypass--;
      if (e.plane === 'orbit') {
        vx = 0;
        vy = 0;
      } else {
        const k = e.seq % 2 ? 1 : -1;
        const rx = -vy * k;
        vy = vx * k;
        vx = rx;
      }
    }
    // Shoving: boxed in, the unit walks into friends standing idle and separation makes them give way.
    if (e.shove > 0) e.shove--;
    const soft = e.shove > 0;
    const wanted = Math.max(pref, norm(e.vx, e.vy));
    // Boxed in: avoidance leaves (nearly) no way toward the goal — sliding sideways between bodies, back and forth, is
    // no way either (that rocking is the jitter in place) — or the cliff/body guards below stop the step.
    const counting = pref > 0 && e.bypass === 0;
    let boxed = false;
    if (wanted > 0) {
      this.avoid(e, vx, vy, wanted, soft);
      if (counting) boxed = (orcaOut.x * vx + orcaOut.y * vy) / pref < STUCK_FRACTION * pref;
      if (pref === 0) {
        // Braking (an exact zero for rotated units alike): ORCA's answer as is.
        vx = orcaOut.x;
        vy = orcaOut.y;
        e.avx = e.avy = 0;
      } else {
        // Smooth (ORCA - wanted) / wanted speed in the wanted heading's frame. This dimensionless bend rotates
        // with turns and scales with terrain/group/arrival speed changes. An old absolute bend can overpower a
        // newly slower wanted velocity, causing an artificial side-step followed by a correction the next tick.
        // Only this nonzero-pref branch normalizes; braking above clears the history instead of dividing by zero.
        // Reconstruct in tiles/tick below, then cap at ORCA's current speed so smoothing never delays its slowdown.
        const ux = vx / pref;
        const uy = vy / pref;
        const bx = (orcaOut.x - vx) / pref;
        const by = (orcaOut.y - vy) / pref;
        e.avx = quantize(e.avx + (bx * ux + by * uy - e.avx) * AVOID_SMOOTH);
        e.avy = quantize(e.avy + (by * ux - bx * uy - e.avy) * AVOID_SMOOTH);
        vx += pref * (ux * e.avx - uy * e.avy);
        vy += pref * (uy * e.avx + ux * e.avy);
        const cap = norm(orcaOut.x, orcaOut.y);
        const len = norm(vx, vy);
        if (len > cap) {
          vx *= cap / len;
          vy *= cap / len;
        }
      }
    }
    const orbit = e.plane === 'orbit' && isStatKind(e.kind) ? this.stats[e.kind] : undefined;
    const a = this.accelOf(e);
    const cur = norm(e.vx, e.vy);
    let nvx: number;
    let nvy: number;
    if (orbit?.orbitTurnRate !== undefined) {
      const desired = norm(vx, vy);
      // Bearings in the owner's frame (signed zeros folded), turned there and rotated back: exact for rotated twins.
      const k = e.frame;
      const current = cur > 0 ? dmath.atan2(canonVY(k, e.vx, e.vy) || 0, canonVX(k, e.vx, e.vy) || 0) : dmath.atan2(canonVY(k, vx, vy) || 0, canonVX(k, vx, vy) || 0);
      const goal = desired > 0 ? dmath.atan2(canonVY(k, vx, vy) || 0, canonVX(k, vx, vy) || 0) : current;
      const delta = wrapPi((goal - current) % TAU);
      const turn = orbit.orbitTurnRate / TICK_RATE;
      const angle = current + Math.max(-turn, Math.min(turn, delta));
      const speed = cur + Math.max(-a, Math.min(a, desired - cur));
      const fx = dmath.cos(angle) * speed;
      const fy = dmath.sin(angle) * speed;
      nvx = rotVX(k, fx, fy);
      nvy = rotVY(k, fx, fy);
    } else {
      let dvx = vx - e.vx;
      let dvy = vy - e.vy;
      // Existing non-Orbit acceleration and braking are unchanged.
      const brake = Math.min(1, Math.max(0, (cur - norm(vx, vy)) / a));
      const lim = Math.min(a * (1 + brake), Math.max(TURN_MIN_ACCEL * a, TURN_SPEED_SHARE * cur));
      const dv = norm(dvx, dvy);
      if (dv > lim) {
        dvx *= lim / dv;
        dvy *= lim / dv;
      }
      nvx = e.vx + dvx;
      nvy = e.vy + dvy;
    }
    if (Math.abs(nvx) < ZERO_EPS && Math.abs(nvy) < ZERO_EPS) nvx = nvy = 0;
    if (e.plane === 'surface' && (nvx !== 0 || nvy !== 0) && (this.surfaceBlocked(e.side, e.x + nvx, e.y + nvy) || !hullLineClear(this.block, e.x, e.y, e.x + nvx, e.y + nvy, e.radius, e.frame, this.size, true))) {
      const xFree = !this.surfaceBlocked(e.side, e.x + nvx, e.y) && hullLineClear(this.block, e.x, e.y, e.x + nvx, e.y, e.radius, e.frame, this.size, true);
      const yFree = !this.surfaceBlocked(e.side, e.x, e.y + nvy) && hullLineClear(this.block, e.x, e.y, e.x, e.y + nvy, e.radius, e.frame, this.size, true);
      // A tie keeps the owner's canonical x axis (world y for a quarter-turned owner), so rotated twins slide alike.
      const ax = Math.abs(nvx);
      const ay = Math.abs(nvy);
      if (xFree && (ax > ay || (ax === ay && e.frame % 2 === 0) || !yFree)) nvy = 0;
      else if (yFree) nvx = 0;
      else nvx = nvy = 0;
    }
    if (e.plane === 'orbit' && this.derelict && (nvx !== 0 || nvy !== 0)) {
      // Ruin walls: slide along the face hit, keeping that part of the momentum.
      this.derelictClip(e, nvx, nvy);
      nvx = route.x;
      nvy = route.y;
    }
    const bodies = soft ? 'firm' : 'all';
    if ((nvx !== 0 || nvy !== 0) && this.crowd(e, e.x + nvx, e.y + nvy, bodies) > Math.max(this.crowd(e, e.x, e.y, bodies), SEP_DEADBAND) + GEOM_EPS) nvx = nvy = 0;
    if (counting) {
      e.stuck = boxed || norm(nvx, nvy) < STUCK_FRACTION * pref ? e.stuck + 1 : 0;
      if (e.stuck === 0 && !soft) e.shoved = false;
      if (e.stuck >= STUCK_TICKS) {
        // Boxed in: shove through friends standing idle against it first; still boxed after that, go around a side.
        e.stuck = 0;
        if (!e.shoved && this.crowd(e, e.x, e.y, 'resting', CONTACT) > 0) {
          e.shove = SHOVE_TICKS;
          e.shoved = true;
        } else {
          e.shove = 0;
          // Still boxed: go around a side (an Orbit ship holds still instead); still getting nowhere after the
          // stall window, it re-plans its destination (Sim.reslot).
          e.bypass = BYPASS_TICKS;
          e.shoved = false;
        }
      }
    }
    if (nvx === 0 && nvy === 0) {
      e.vx = 0;
      e.vy = 0;
      return;
    }
    e.vx = quantize(nvx);
    e.vy = quantize(nvy);
    e.x = clampPos(e.x + e.vx, this.size);
    e.y = clampPos(e.y + e.vy, this.size);
  }

  /**
   * ORCA over the nearest bodies on `e`'s plane (start-of-tick positions and velocities); the answer is in orcaOut.
   * `soft`: own units that stood idle at the start of the tick are left out (the unit shoves through them).
   */
  avoid(this: Sim, e: Ent, vx: number, vy: number, speed: number, soft = false): void {
    const range = e.radius + MAX_BODY_RADIUS + 2 * ORCA_TAU * speed;
    let n = 0;
    const pb = PLANE_INDEX[e.plane] * this.bucketCount;
    const bx0 = Math.max(0, ((e.x - range) / BUCKET) | 0);
    const bx1 = Math.min(this.bucketWidth - 1, ((e.x + range) / BUCKET) | 0);
    const by0 = Math.max(0, ((e.y - range) / BUCKET) | 0);
    const by1 = Math.min(this.bucketWidth - 1, ((e.y + range) / BUCKET) | 0);
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let k = this.bucketHead[pb + by * this.bucketWidth + bx]!; k >= 0; k = this.bucketNext[k]!) {
          const o = this.ents[k]!;
          if (o === e || o.dead || o.plane !== e.plane || isNeutralKind(o.kind)) continue;
          if (e.plane === 'sky' && Math.abs(e.elevation - o.elevation) > e.radius + o.radius) continue;
          if (soft && o.side === e.side && this.rest[k] === 1) continue;
          // Distances on the velocity grid, so rotated units rank their neighbours alike despite last-bit noise.
          const d = quantize(o.structure ? footprintDistance(o.kind, o.x, o.y, e.x, e.y) : norm(o.x - e.x, o.y - e.y) - o.radius);
          if (d > range) continue;
          // Keep the nearest ORCA_MAX_NEIGHBOURS, ordered by distance, then serial, own army first, then other armies
          // by relative order from `e` (rotation-stable).
          let at = n < ORCA_MAX_NEIGHBOURS ? n : ORCA_MAX_NEIGHBOURS;
          while (at > 0) {
            const p = this.nearBy[at - 1]!;
            const pd = this.nearD[at - 1]!;
            if (pd < d || (pd === d && (p.seq < o.seq || (p.seq === o.seq && (p.side === e.side
              || (o.side !== e.side && isArmy(p.side) && isArmy(o.side) && this.rel(e.side, p.side) < this.rel(e.side, o.side))))))) break;
            if (at < ORCA_MAX_NEIGHBOURS) {
              this.nearBy[at] = p;
              this.nearD[at] = pd;
            }
            at--;
          }
          if (at < ORCA_MAX_NEIGHBOURS) {
            this.nearBy[at] = o;
            this.nearD[at] = d;
            if (n < ORCA_MAX_NEIGHBOURS) n++;
          }
        }
      }
    }
    orcaBegin();
    for (let i = 0; i < n; i++) {
      const o = this.nearBy[i]!;
      // Moving units avoid back (they take half); bodies at rest do not. Velocities are start-of-tick (held back), so
      // this reads nothing another unit decided this tick.
      const share = o.unit && (o.vx !== 0 || o.vy !== 0) ? ORCA_SHARE : 1;
      const f = o.structure && isStatKind(o.kind) ? this.stats[o.kind].footprint : undefined;
      const dx = f ? Math.max(o.x - f.w / 2, Math.min(e.x, o.x + f.w / 2)) - e.x : o.x - e.x;
      const dy = f ? Math.max(o.y - f.h / 2, Math.min(e.y, o.y + f.h / 2)) - e.y : o.y - e.y;
      orcaNeighbour(e.vx, e.vy, dx, dy, e.vx - o.vx, e.vy - o.vy, e.radius + (f ? 0 : o.radius), ORCA_TAU, share);
    }
    orcaSolve(vx, vy, speed);
  }

  /**
   * Seek (x, y) at up to `speed` tiles/tick. With `arrive`, it slows down to stop `stop` tiles short of the point
   * (exactly on it when 0); a pass-through waypoint is taken at full speed (`drive` avoids bodies on the way).
   * (leadX, leadY): the point's own velocity (tiles/tick) — a pursued target's start-of-tick velocity, a fleet slot's
   * travel — added on top, so arrival braking limits closing speed, not absolute speed.
   * True once there, or right beside a spot someone else is standing on.
   */
  steer(this: Sim, e: Ent, x: number, y: number, speed: number, stop = 0, arrive = true, leadX = 0, leadY = 0): boolean {
    // Orbit around the derelict ruin: through a breach or open gate, round the hull or ring (keeping the side it goes
    // round on), or held at a sealed gate.
    if (e.plane === 'orbit' && this.derelict) {
      const routed = this.derelictRoute(e.x, e.y, e.radius, x, y, e.skirt);
      e.skirt = route.skirt;
      if (routed) {
        const hold = route.hold;
        this.steerDirect(e, route.x, route.y, speed, 0, hold);
        return false;
      }
    }
    return this.steerDirect(e, x, y, speed, stop, arrive, leadX, leadY);
  }

  steerDirect(this: Sim, e: Ent, x: number, y: number, speed: number, stop = 0, arrive = true, leadX = 0, leadY = 0): boolean {
    const dx = x - e.x;
    const dy = y - e.y;
    const d = norm(dx, dy);
    const left = d - stop;
    const led = leadX !== 0 || leadY !== 0;
    // Someone else standing on the spot: arrived once slowed down beside it. A travelling fleet slot is never reached.
    // Within a slot gap of it, slow enough to stop and with a neighbour's hull reaching into it, the unit has arrived
    // too: closing the last fraction would mean pushing that neighbour off its own slot (they would trade nudges).
    const a = this.accelOf(e);
    const still = norm(e.vx, e.vy);
    if (arrive && !(led && stop === 0) && (left <= SNAP_EPS
      || (e.plane !== 'orbit' && d < e.radius * CROWD_RADII && still <= this.baseSpeed(e) / this.econ.moveRamp && this.crowd(e, x, y) > e.radius)
      || (stop === 0 && d <= this.econ.slotGap && still <= Math.max(a, ARRIVE_EPS) && this.crowd(e, x, y) > 0))) {
      this.drive(e, 0, 0);
      return e.plane !== 'orbit' || norm2(e.vx, e.vy) <= sq(ARRIVE_EPS);
    }
    let s = speed;
    const turn = e.plane === 'orbit' && isStatKind(e.kind) ? this.stats[e.kind].orbitTurnRate : undefined;
    if (arrive && left > 0) {
      // Braking a per tick from s covers s²/2a + s/2 tiles: stop on the point instead of overshooting it (a ship
      // with inertia would otherwise loop back round), and never step past it in one tick.
      s = Math.min(s, Math.sqrt(2 * a * left + a * a / 4) - a / 2, left);
      if (turn === undefined) s = Math.min(s, ARRIVE_APPROACH * left);
    } else if (arrive) s = 0;
    if (turn !== undefined && left > 0 && s > 0) {
      // Turn-limited: at speed v the tightest circle has radius v / ω, which reaches a point `left` away at bearing
      // θ off the current heading only if v ≤ ω · left / (2 sin θ) (sin θ read as 1 once it lies behind) — for a
      // waypoint passed through as much as for a point arrived at: a ship slows for a sharp turn (into a breach, onto
      // the arc round a wall) rather than sweeping wide into the wall. Already heading at it (or at rest), only
      // braking limits the approach, so arrival takes finite time. A point to arrive at behind it, within the turning
      // circle's reach, is reached sooner by stopping: at rest a ship heads anywhere.
      const rvx = e.vx - leadX;
      const rvy = e.vy - leadY;
      const rs = norm(rvx, rvy);
      if (rs > 0) {
        const w = turn / TICK_RATE;
        const cos = (rvx * dx + rvy * dy) / (rs * d);
        const sin = cos <= 0 ? 1 : Math.sqrt(Math.max(0, 1 - cos * cos));
        if (arrive && cos <= 0 && left < (2 * rs) / w) s = 0;
        else if (sin > 0) s = Math.min(s, w * left / (2 * sin));
      }
    }
    let vx = d > 0 ? (dx / d) * s : 0;
    let vy = d > 0 ? (dy / d) * s : 0;
    if (led) {
      vx += leadX;
      vy += leadY;
      const length = norm(vx, vy);
      if (length > speed) {
        vx *= speed / length;
        vy *= speed / length;
      }
    }
    if (e.plane === 'orbit' && this.derelict) {
      // Against a ruin wall's face: slide along it instead of pressing in (and being pushed back out).
      this.derelictSkim(e, vx, vy);
      vx = route.x;
      vy = route.y;
    }
    this.drive(e, vx, vy);
    // Settle deadband: within ARRIVE_SETTLE of a still point and slow enough to stop this tick, it is there.
    if (arrive && stop === 0 && !led && norm2(x - e.x, y - e.y) <= sq(ARRIVE_SETTLE) && norm2(e.vx, e.vy) <= sq(Math.max(a, ARRIVE_EPS))) {
      e.x = clampPos(x, this.size);
      e.y = clampPos(y, this.size);
      e.vx = 0;
      e.vy = 0;
      return true;
    }
    return false;
  }

  /** Acceleration (tiles/tick²): the registry's Orbit thrust, else base speed over the rules' acceleration time. */
  accelOf(this: Sim, e: Ent): number {
    const thrust = e.plane === 'orbit' && isStatKind(e.kind) ? this.stats[e.kind].orbitAcceleration : undefined;
    return thrust === undefined ? this.baseSpeed(e) / this.econ.moveRamp : thrust / (TICK_RATE * TICK_RATE);
  }

  /**
   * Arrival watchdog (open planes; depths units follow tunnel paths): no headway toward (x, y) (PROGRESS tiles) for
   * STALL_TICKS of steady steering within CROWD_ARRIVE of it — others crowd the point, or bodies and cliffs pin the
   * unit — so this is as close as it gets.
   */
  stalled(this: Sim, e: Ent, x: number, y: number): boolean {
    const d = this.stall(e, x, y);
    return d >= 0 && d < CROWD_ARRIVE;
  }

  /**
   * Stuck detection: the distance to (x, y) once the unit has gained less than PROGRESS tiles on it over STALL_TICKS
   * of steady steering, else -1. A turn-limited ship also gets the time to turn round (half a turn at its rate): one
   * that overshot is coming back, not stuck. Call once per tick per unit (it tracks the headway).
   */
  stall(this: Sim, e: Ent, x: number, y: number): number {
    if (e.plane === 'depths') return -1;
    // Waiting at a sealed gate or routing round the hull is not being stuck, however close the point is.
    const g = this.derelict;
    if (e.plane === 'orbit' && g && wallBlocks(g, gatesOpen(g, this.tick), e.x - g.x, e.y - g.y, x - g.x, y - g.y, e.radius)) return -1;
    const d = norm(x - e.x, y - e.y);
    const steady = x === e.progX && y === e.progY && e.progLast === this.tick - 1;
    e.progLast = this.tick;
    if (!steady || d < e.progD - PROGRESS) {
      e.progX = x;
      e.progY = y;
      e.progD = d;
      e.progAt = this.tick;
      return -1;
    }
    const turn = e.plane === 'orbit' && isStatKind(e.kind) ? this.stats[e.kind].orbitTurnRate : undefined;
    // A ship holding because it is boxed in (bypass) is not turning round: it gets no extra time.
    const patience = STALL_TICKS + (turn === undefined || e.bypass > 0 ? 0 : Math.ceil((Math.PI / turn) * TICK_RATE));
    return this.tick - e.progAt >= patience ? d : -1;
  }

  /**
   * Re-plan a stuck move (`e` made no headway, `d` tiles short of its current destination (dx, dy) — a fleet member's
   * slot round the halted waypoint): the free point nearest the unit on its ring lattice round that destination, clear
   * of the army's other units standing or headed there, within the disc those units (and it) fill when hex-packed plus
   * one slot — the near edge of the crowd it is stuck behind, never a spot short of a traffic jam on the way. Taken
   * only if it is nearer by PROGRESS (so re-plans walk the slot toward the unit and end). Nothing nearer and the unit
   * already within one more slot of that disc (or CROWD_ARRIVE): this is as close as it gets, so the spot it holds
   * becomes its destination (for a fleet member, its slot, so the fleet can go on or finish). False: unchanged.
   */
  reslot(this: Sim, e: Ent, d: number, dx: number, dy: number): boolean {
    const o = e.order;
    if (o.k !== 'move') return false;
    const k = this.armyFrame[e.side]!;
    const size = this.size;
    const gap = this.econ.slotGap;
    const step = 2 * e.radius + gap;
    let area = sq(e.radius + gap / 2);
    const placed = this.claimedDiscs(e.side, e.plane, dx, dy, d, [e]).map((p) => {
      area += sq(p.r + gap / 2);
      return { x: canonX(k, p.x, p.y, size), y: canonY(k, p.x, p.y, size), r: p.r };
    });
    const gx = clampPos(canonX(k, dx, dy, size), size);
    const gy = clampPos(canonY(k, dx, dy, size), size);
    // The destination itself counts as taken: the way to it is what is blocked.
    placed.push({ x: gx, y: gy, r: 0 });
    const within = Math.sqrt(area / HEX_PACKING) + step;
    // Only a unit pressed against bodies is stuck behind a crowd; one going the long way round terrain is not.
    const pressed = this.crowd(e, e.x, e.y, 'all', CONTACT) > 0;
    const slot = pressed && d - e.radius < within + step ? this.ringSlot(e.side, e.plane, e.radius, gx, gy, canonX(k, e.x, e.y, size), canonY(k, e.x, e.y, size), placed, within) : null;
    let x = dx;
    let y = dy;
    if (slot) {
      const qx = clampPos(slot[0], size);
      const qy = clampPos(slot[1], size);
      [x, y] = this.reachableNear(e, rotX(k, qx, qy, size), rotY(k, qx, qy, size));
    }
    if (norm(x - e.x, y - e.y) >= d - PROGRESS) {
      // Settling where it stands needs that spot to be one it could have been given (never against its own Spire).
      if (d >= (pressed ? Math.max(CROWD_ARRIVE, within + step) : CROWD_ARRIVE) || !this.slotOpen(e.side, e.plane, canonX(k, e.x, e.y, size), canonY(k, e.x, e.y, size), e.radius)) return false;
      x = e.x;
      y = e.y;
    }
    const f = o.fleet;
    if (f) {
      // The slot is an offset from the (halted) waypoint; the order's destination follows it to the goal.
      o.ox = x - f.x;
      o.oy = y - f.y;
      o.x = clampPos(f.goalX + o.ox, size);
      o.y = clampPos(f.goalY + o.oy, size);
    } else {
      o.x = x;
      o.y = y;
    }
    return true;
  }

  /**
   * Deepest overlap `e` would have with any other body on its plane if it stood at (x, y), `margin` closer (a contact
   * test). `bodies`: 'firm' leaves out own units that stood idle at the start of the tick (`rest`), 'resting' counts
   * only those, 'still' only bodies not moving at the start of the tick (structures, parked and planted units).
   */
  crowd(this: Sim, e: Ent, x: number, y: number, bodies: 'all' | 'firm' | 'resting' | 'still' = 'all', margin = 0): number {
    let worst = 0;
    const pb = PLANE_INDEX[e.plane] * this.bucketCount;
    const m = e.radius + MAX_BODY_RADIUS + margin;
    const bx0 = Math.max(0, ((x - m) / BUCKET) | 0);
    const bx1 = Math.min(this.bucketWidth - 1, ((x + m) / BUCKET) | 0);
    const by0 = Math.max(0, ((y - m) / BUCKET) | 0);
    const by1 = Math.min(this.bucketWidth - 1, ((y + m) / BUCKET) | 0);
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let k = this.bucketHead[pb + by * this.bucketWidth + bx]!; k >= 0; k = this.bucketNext[k]!) {
          const o = this.ents[k]!;
          if (o === e || o.dead || o.plane !== e.plane || isNeutralKind(o.kind)) continue;
          if (e.plane === 'sky' && Math.abs(e.elevation - o.elevation) > e.radius + o.radius) continue;
          if (bodies === 'still' ? o.vx !== 0 || o.vy !== 0 : bodies !== 'all' && (o.side === e.side && this.rest[k] === 1) !== (bodies === 'resting')) continue;
          const ov = e.radius + margin - (o.structure ? footprintDistance(o.kind, o.x, o.y, x, y) : norm(x - o.x, y - o.y) - o.radius);
          if (ov > worst) worst = ov;
        }
      }
    }
    return worst;
  }

  /** Own speed in tiles/tick, before terrain (towing tugs are slower). Groups move at their slowest base speed. */
  baseSpeed(this: Sim, e: Ent): number {
    const s = this.stat(e).speed / TICK_RATE;
    const rock = this.capable(e, 'tow') && e.link ? this.alive(e.link) : undefined;
    return rock?.kind === 'asteroid' ? s * this.rocks[rock.rockSize].tow : rock?.kind === 'core' ? s * this.econ.coreTowSpeed : s;
  }

  /** Current speed (tiles/tick): the group's pace while moving together, slowed by forests and fords on the surface. */
  speedOf(this: Sim, e: Ent, dx = e.vx, dy = e.vy): number {
    let s = this.baseSpeed(e);
    if (e.order.k === 'move' && e.order.speed > 0 && e.order.speed < s && !e.engage) s = e.order.speed;
    if (e.plane === 'surface') {
      const v = this.terrain[cellOfEnt(e, this.size)]!;
      if (surfaceFeature(v) === SURFACE.forest) s *= this.econ.forestSpeed;
      else if (surfaceFeature(v) === SURFACE.ford) s *= this.econ.fordSpeed;
    }
    if (e.plane === 'sky' && e.unit && isAirArmor(this.armorOf(e))) {
      s *= 1 + (this.econ.stormSpeed - 1) * this.weather.strengthAt(e.x, e.y);
      s *= this.weather.windAt(e.x, e.y, dx, dy);
    }
    return s;
  }

  /**
   * Move toward a point on the unit's plane (`stop`: halt that far short of it): NAV_MOVING, NAV_ARRIVED or NAV_BLOCKED.
   * Depths units follow tunnel paths; the open planes steer, and on the surface (once cliffs or holes exist) they
   * steer at the farthest visible cell a few steps down the goal's flow field (any-angle, shared per goal).
   */
  navTo(this: Sim, e: Ent, x: number, y: number, stop = 0): NavStep {
    if (e.plane === 'depths') {
      const goal = cellFor(e.frame, x, y, this.size);
      if (!e.path || e.navGoal !== goal) {
        if (!this.planDepths(e, goal, false)) return NAV_BLOCKED;
      }
      const r = this.followDepths(e, false);
      if (r === NAV_BLOCKED) return this.planDepths(e, goal, false) ? NAV_MOVING : NAV_BLOCKED;
      return r === NAV_ARRIVED ? NAV_ARRIVED : NAV_MOVING;
    }
    const speed = this.speedOf(e, x - e.x, y - e.y);
    if (e.plane !== 'surface') return this.steer(e, x, y, speed, stop) ? NAV_ARRIVED : NAV_MOVING;
    const goal = cellFor(e.frame, x, y, this.size);
    if (this.surfaceNav[e.side]![goal]) return NAV_BLOCKED;
    if (e.navGoal !== goal || e.navVer !== this.holesVersion || this.tick - e.navAt >= NAV_REPLAN || (!e.navDirect && norm2(e.wx - e.x, e.wy - e.y) < sq(WAYPOINT_REACH))) {
      if (!this.planSurface(e, goal, x, y)) return NAV_BLOCKED;
    }
    if (e.navDirect) return this.steer(e, x, y, speed, stop) ? NAV_ARRIVED : NAV_MOVING;
    this.steer(e, e.wx, e.wy, speed, 0, false);
    return NAV_MOVING;
  }

  /** Pick the surface waypoint toward (x, y) in `goal`: the point itself in plain sight, else the flow-field lookahead. */
  planSurface(this: Sim, e: Ent, goal: number, x: number, y: number): boolean {
    const frame = e.frame;
    e.navGoal = goal;
    e.navVer = this.holesVersion;
    e.navAt = this.tick;
    const blocked = this.surfaceNav[e.side]!;
    e.navDirect = hullLineClear(blocked, e.x, e.y, x, y, e.radius, frame, this.size, true);
    if (e.navDirect) return true;
    const flows = this.flows[e.side]!;
    const anchor = flows.anchor(x, y, frame, this.holesVersion, this.tick, e.radius);
    if (anchor >= 0 && this.lookahead(e, flows.get(anchor, frame, this.holesVersion, this.tick, e.radius), frame)) return true;
    e.navGoal = GOAL_NONE;
    return false;
  }

  /** Waypoint (wx, wy): the farthest cell in plain sight a few steps down `field` (in frame `frame`); false if `e` is cut off from it. */
  lookahead(this: Sim, e: Ent, field: Float64Array, frame: number): boolean {
    const flows = this.flows[e.side]!;
    let c = flows.anchor(e.x, e.y, frame, this.holesVersion, this.tick, e.radius, field, true);
    if (c < 0) return false;
    const geometry = flows.geometry(e.radius, frame, this.holesVersion, this.tick);
    let pick = c;
    for (let k = 0; k < NAV_LOOKAHEAD; k++) {
      const n = flows.descend(field, c, frame, this.holesVersion, this.tick, e.radius);
      if (n < 0) break;
      c = n;
      if (hullLineClear(this.surfaceNav[e.side]!, e.x, e.y, geometry.x[n]!, geometry.y[n]!, e.radius, frame, this.size, true)) pick = n;
    }
    e.wx = geometry.x[pick]!;
    e.wy = geometry.y[pick]!;
    return true;
  }

  /**
   * Orbit attackers spread round their target instead of piling onto one arc: within CROWD_ARRIVE of the firing ring
   * (`stop` tiles from a unit target), when a body standing still blocks the point on `e`'s own bearing, the free point
   * nearest it round that ring (stepped by e's size, the frame's positive side first on a tie) goes in `spot`. False:
   * steer at the target itself (the bearing point is free, the target is a structure, or the ring is full).
   */
  firingSpot(this: Sim, e: Ent, t: Ent, stop: number): boolean {
    if (t.structure || t.plane !== e.plane) return false;
    const dx = e.x - t.x;
    const dy = e.y - t.y;
    const d = norm(dx, dy);
    if (d === 0 || d - stop > CROWD_ARRIVE) return false;
    const gap = this.econ.slotGap;
    // Bearings in the owner's frame (signed zeros folded), rotated back: exact for rotated twins.
    const k = e.frame;
    const a0 = dmath.atan2(canonVY(k, dx, dy) || 0, canonVX(k, dx, dy) || 0);
    const da = (2 * e.radius + gap) / stop;
    for (let j = 0; j * da <= Math.PI; j++) {
      for (const side of j === 0 ? ONE_SIDE : BOTH_SIDES) {
        const a = a0 + side * j * da;
        const c = dmath.cos(a) * stop;
        const s = dmath.sin(a) * stop;
        const x = clampPos(t.x + rotVX(k, c, s), this.size);
        const y = clampPos(t.y + rotVY(k, c, s), this.size);
        if (this.crowd(e, x, y, 'still', gap) > SNAP_EPS) continue;
        if (j === 0) return false;
        spot.x = x;
        spot.y = y;
        return true;
      }
    }
    return false;
  }

  /**
   * Close in on `t` until `e` can fire at it (explicit attacks): NAV_MOVING, NAV_ARRIVED (in place) or NAV_BLOCKED (no
   * firing spot reachable).
   * Among surface holes and cliffs it heads for the nearest cell it could fire from (`firingField`), not the target's
   * centre: a Spire ringed by craters is shot at from the rim, a unit across a chasm from the edge.
   */
  approach(this: Sim, e: Ent, t: Ent): NavStep {
    const stop = this.firingDistance(e, t);
    if (e.plane === 'orbit') {
      const seen = this.sees(e.side, t);
      const speed = this.speedOf(e, t.x - e.x, t.y - e.y);
      const lx = seen ? t.tvx : 0;
      const ly = seen ? t.tvy : 0;
      if (this.firingSpot(e, t, stop)) return this.steer(e, spot.x, spot.y, speed, 0, true, lx, ly) ? NAV_ARRIVED : NAV_MOVING;
      return this.steer(e, t.x, t.y, speed, stop, true, lx, ly) ? NAV_ARRIVED : NAV_MOVING;
    }
    if (e.plane !== 'surface') return this.navTo(e, t.x, t.y, stop);
    // A unit target moves: chase it straight while there is a way to where it stands.
    if (!t.structure) {
      const r = this.navTo(e, t.x, t.y, stop);
      if (r !== NAV_BLOCKED) return r;
    }
    const frame = e.frame;
    const field = this.firingField(e, t);
    const flows = this.flows[e.side]!;
    const c = flows.anchor(e.x, e.y, frame, this.holesVersion, this.tick, e.radius, field, true);
    if (c < 0) {
      e.navGoal = GOAL_NONE;
      return NAV_BLOCKED;
    }
    const geometry = flows.geometry(e.radius, frame, this.holesVersion, this.tick);
    const speed = this.speedOf(e);
    if (field[c] === 0) {
      // At a visible firing representative: approach firing distance when that spot is clear, otherwise the
      // representative itself (tested at its exact coordinates for range, elevation and line of fire).
      const d = norm(t.x - e.x, t.y - e.y);
      if (d > stop) {
        const sx = t.x + ((e.x - t.x) / d) * stop;
        const sy = t.y + ((e.y - t.y) / d) * stop;
        if (field[cellFor(frame, sx, sy, this.size)] === 0 && hullLineClear(this.surfaceNav[e.side]!, e.x, e.y, sx, sy, e.radius, frame, this.size, true)) return this.steer(e, t.x, t.y, speed, stop) ? NAV_ARRIVED : NAV_MOVING;
      }
      return this.steer(e, geometry.x[c]!, geometry.y[c]!, speed) ? NAV_ARRIVED : NAV_MOVING;
    }
    if (e.navGoal !== GOAL_FIRING || e.navVer !== this.holesVersion || this.tick - e.navAt >= NAV_REPLAN || norm2(e.wx - e.x, e.wy - e.y) < sq(WAYPOINT_REACH)) {
      e.navGoal = GOAL_FIRING;
      e.navVer = this.holesVersion;
      e.navAt = this.tick;
      e.navDirect = false;
      if (!this.lookahead(e, field, frame)) {
        e.navGoal = GOAL_NONE;
        return NAV_BLOCKED;
      }
    }
    this.steer(e, e.wx, e.wy, speed, 0, false);
    return NAV_MOVING;
  }

  /** Can `e` get to a spot it could fire at `t` from (or is it at one)? */
  canReachFiring(this: Sim, e: Ent, t: Ent): boolean {
    if (e.plane !== 'surface' || this.inRange(e, t)) return true;
    if (!t.structure && this.reachable(e, t.x, t.y)) return true;
    return this.flows[e.side]!.anchor(e.x, e.y, e.frame, this.holesVersion, this.tick, e.radius, this.firingField(e, t), true) >= 0;
  }

  /** Can surface unit `e` walk to (x, y)? */
  reachable(this: Sim, e: Ent, x: number, y: number): boolean {
    const blocked = this.surfaceNav[e.side]!;
    if (hullLineClear(blocked, e.x, e.y, x, y, e.radius, e.frame, this.size, true)) return true;
    const flows = this.flows[e.side]!;
    const goal = flows.anchor(x, y, e.frame, this.holesVersion, this.tick, e.radius);
    return goal >= 0 && flows.anchor(e.x, e.y, e.frame, this.holesVersion, this.tick, e.radius, flows.get(goal, e.frame, this.holesVersion, this.tick, e.radius), true) >= 0;
  }

  /**
   * Where surface unit `e` should head for (x, y): the point itself if it can walk there, else the centre of the
   * nearest cell it can reach (an order into a pocket cut off by holes goes as close as it can, not nowhere).
   */
  reachableNear(this: Sim, e: Ent, x: number, y: number): [number, number] {
    if (e.plane !== 'surface' || this.reachable(e, x, y)) return [x, y];
    const frame = e.frame;
    // The graph edges are symmetric; attach the exact start before finding its reachable component.
    const flows = this.flows[e.side]!;
    const start = flows.anchor(e.x, e.y, frame, this.holesVersion, this.tick, e.radius, undefined, true);
    if (start < 0) return [e.x, e.y];
    const from = flows.get(start, frame, this.holesVersion, this.tick, e.radius);
    const geometry = flows.geometry(e.radius, frame, this.holesVersion, this.tick);
    // Nearest representative, scanning the unit's frame row-major order (ties resolve alike for rotated units).
    let best = start;
    let bd = Infinity;
    for (let f = 0; f < this.n; f++) {
      const c = rotCell(frame, f, this.size);
      if (from[c] === Infinity) continue;
      const d = sq(geometry.x[c]! - x) + sq(geometry.y[c]! - y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return [geometry.x[best]!, geometry.y[best]!];
  }

  /** Flow field (in `e`'s frame) toward every surface cell `e` could fire at `t` from, shared per target and reach. */
  firingField(this: Sim, e: Ent, t: Ent): Float64Array {
    const reach = Math.round((this.stat(e).range + t.radius + this.rangeBonus(e, t)) * FIRING_REACH_STEPS);
    // Structures key after every plane's cells (by id); units by plane and cell.
    const anchor = t.structure ? PLANES.length * this.n + t.id : PLANE_INDEX[t.plane] * this.n + cellOfEnt(t, this.size);
    return this.flows[e.side]!.getSet(anchor * FIRING_KEY_STRIDE + reach, e.frame, this.holesVersion, this.tick, () => this.firingCells(e, t), e.radius);
  }

  /**
   * Open surface representatives, in `e`'s frame order (rotation-exact fields), within firing distance of
   * `t`'s body (high ground adds range) with a line of fire. A unit target may stand anywhere in its cell, so its ring
   * is measured from the cell centre and shrunk by the half diagonal.
   */
  firingCells(this: Sim, e: Ent, t: Ent): number[] {
    const frame = e.frame;
    const tc = cellOfEnt(t, this.size);
    const geometry = this.flows[e.side]!.geometry(e.radius, frame, this.holesVersion, this.tick);
    let cx: number;
    let cy: number;
    if (t.structure) {
      cx = canonX(frame, t.x, t.y, this.size);
      cy = canonY(frame, t.x, t.y, this.size);
    } else {
      const f = canonCell(frame, tc, this.size);
      cx = cellCentreX(f, this.size);
      cy = cellCentreY(f, this.size);
    }
    const slack = t.structure ? 0 : Math.SQRT1_2;
    const base = this.stat(e).range + (t.structure ? 0 : t.radius) + this.rangeBonus(e, t);
    const sightless = t.plane === 'surface' && !isSurfaceHigh(this.terrain[tc]!);
    const far = base + this.econ.highRange + (t.structure ? MAX_BODY_RADIUS : 0) + Math.SQRT1_2;
    const out: number[] = [];
    for (let y = Math.max(0, Math.floor(cy - far)); y <= Math.min(this.size - 1, Math.floor(cy + far)); y++) {
      for (let x = Math.max(0, Math.floor(cx - far)); x <= Math.min(this.size - 1, Math.floor(cx + far)); x++) {
        const c = rotCell(frame, y * this.size + x, this.size);
        if (geometry.blocked[c]) continue;
        const wx = geometry.x[c]!, wy = geometry.y[c]!;
        const at = cellFor(frame, wx, wy, this.size);
        const px = canonX(frame, wx, wy, this.size), py = canonY(frame, wx, wy, this.size);
        const high = isSurfaceHigh(this.terrain[at]!);
        const r = Math.max(this.econ.minFiringRange, base + (high ? this.econ.highRange : 0) - RANGE_MARGIN) - SNAP_EPS - slack;
        const dx = px - cx;
        const dy = py - cy;
        const distance = t.structure ? footprintDistance(t.kind, cx, cy, px, py) : norm(dx, dy);
        if (r < 0 || distance > r) continue;
        if (sightless && !high && !this.los.visible(at, tc)) continue;
        out.push(c);
      }
    }
    return out;
  }

  /** Advance a common waypoint only while every surviving member keeps up with its slot. */
  advanceFleet(this: Sim, f: FleetMove): void {
    if (f.updated === this.tick) return;
    f.updated = this.tick;
    if (!f.started) {
      let count = 0;
      let cx = 0;
      let cy = 0;
      // The centroid in the fleet army's frame, rotated back: rotated fleets get exactly rotated waypoints.
      const k = this.armyFrame[f.side]!;
      for (const id of f.members) {
        const e = this.alive(id);
        if (!e || e.plane !== 'orbit') continue;
        if (e.order.k !== 'move' || e.order.fleet !== f) {
          // An earlier queued leg may finish a few ticks apart across the fleet.
          for (const q of e.queue) if (q.k === 'move' && q.fleet === f) return;
          continue;
        }
        cx += canonX(k, e.x, e.y, this.size);
        cy += canonY(k, e.x, e.y, this.size);
        count++;
      }
      if (!count) return;
      const anchor = this.alive(f.anchor);
      const anchored = anchor?.order.k === 'move' && anchor.order.fleet === f;
      f.x = clampPos(anchored ? anchor.x : rotX(k, cx / count, cy / count, this.size), this.size);
      f.y = clampPos(anchored ? anchor.y : rotY(k, cx / count, cy / count, this.size), this.size);
      f.started = true;
    }
    let pace = Infinity;
    let accel = Infinity;
    let biggest = 0;
    let reach = 0;
    let worst = 0;
    let waiting = false;
    let settled = f.x === f.goalX && f.y === f.goalY;
    const g = this.derelict;
    const open = g ? gatesOpen(g, this.tick) : false;
    for (const id of f.members) {
      const e = this.alive(id);
      if (!e || e.plane !== 'orbit' || e.order.k !== 'move' || e.order.fleet !== f) continue;
      const o = e.order;
      pace = Math.min(pace, this.baseSpeed(e));
      accel = Math.min(accel, this.accelOf(e));
      biggest = Math.max(biggest, e.radius);
      reach = Math.max(reach, norm(o.ox!, o.oy!) + e.radius);
      const sx = clampPos(f.x + o.ox!, this.size);
      const sy = clampPos(f.y + o.oy!, this.size);
      const error = norm(e.x - sx, e.y - sy);
      if (e.engage) waiting = true;
      // A member whose slot lies in or across the ruin's walls goes round them on its own, and one whose slot sweeps
      // through a body (ships parked on the way) gets past it as it can: the fleet waits for neither.
      else if ((!g || !(wallHit(g, open, sx - g.x, sy - g.y, e.radius) || wallBlocks(g, open, e.x - g.x, e.y - g.y, sx - g.x, sy - g.y, e.radius))) && this.crowd(e, sx, sy) <= SEP_DEADBAND) worst = Math.max(worst, error);
      if (error > ARRIVE_EPS || norm2(e.vx, e.vy) > sq(ARRIVE_EPS)) settled = false;
    }
    f.finished = settled;
    const top = pace === Infinity ? 0 : pace;
    for (const id of f.members) {
      const e = this.alive(id);
      if (e?.order.k === 'move' && e.order.fleet === f) e.order.speed = top;
    }
    // Head for the goal, or round the ruin: the whole formation as one disc while it fits outside the hull at both
    // ends, else (into the ruin, or a goal against the hull) its largest ship, the others routing on their own.
    let hx = f.goalX;
    let hy = f.goalY;
    let hold = false;
    if (g) {
      const clear = g.hullOuter + reach + this.econ.slotGap;
      const fits = norm(f.x - g.x, f.y - g.y) >= clear && norm(f.goalX - g.x, f.goalY - g.y) >= clear;
      // The disc keeps one more WALL_CLEAR, so its innermost members ride the arc that far off the face, clear of the
      // margin where they would go round on their own (and flicker between their slot and the arc).
      const routed = this.derelictRoute(f.x, f.y, (fits ? reach : biggest) + WALL_CLEAR, f.goalX, f.goalY, f.skirt);
      f.skirt = route.skirt;
      if (routed) {
        hx = route.x;
        hy = route.y;
        hold = route.hold;
      }
    }
    const dx = hx - f.x;
    const dy = hy - f.y;
    const distance = norm(dx, dy);
    const left = hold || (hx === f.goalX && hy === f.goalY) ? distance : Infinity;
    // The waypoint slows as its worst member trails past half of formationSlack (to a stop at formationSlack) instead
    // of lurching between full pace and a halt — a member keeping station within that half never touches the pace, so
    // slot-keeping noise does not feed back into it — ramps at the slowest member's thrust and brakes to stop on the
    // goal: members leading their slots by its step can follow it without overshooting.
    const slack = this.econ.formationSlack;
    let want = waiting || accel === Infinity ? 0 : top * Math.min(1, Math.max(0, (slack - worst) / (slack / 2)));
    // Braking at only FLEET_BRAKE_SHARE of the slowest thrust leaves members (leading by this step) the rest to
    // correct their slot error, so a heavy hull stops in its slot instead of coasting past it.
    const brake = accel * FLEET_BRAKE_SHARE;
    if (left !== Infinity) want = Math.min(want, Math.sqrt(2 * brake * left + brake * brake / 4) - brake / 2);
    f.speed = accel === Infinity ? 0 : quantize(Math.max(0, f.speed - accel, Math.min(want, f.speed + accel)));
    const x0 = f.x;
    const y0 = f.y;
    if (distance > 0 && f.speed > 0) {
      if (distance <= f.speed) {
        f.x = hx;
        f.y = hy;
      } else {
        f.x = clampPos(f.x + quantize(dx / distance * f.speed), this.size);
        f.y = clampPos(f.y + quantize(dy / distance * f.speed), this.size);
      }
    }
    f.vx = f.x - x0;
    f.vy = f.y - y0;
  }

  /**
   * Deterministic, damped separation. Each overlapping pair (deeper than SEP_DEADBAND) is resolved once,
   * symmetrically: structures never move; units at rest share the correction; a moving unit only side-steps
   * (lateral to its motion) instead of being shoved back, while the resting one makes way. Corrections are damped
   * (SEP_DAMP of the overlap per tick), normalized by each body's total contact responsibility, and capped.
   * Normalization prevents opposing contacts from overshooting without weakening an isolated pair's separation.
   */
  separate(this: Sim): void {
    const ents = this.ents;
    const n = ents.length;
    if (this.pushX.length < n) {
      this.pushX = new Float64Array(n * 2);
      this.pushY = new Float64Array(n * 2);
      this.pushWeight = new Float64Array(n * 2);
      this.pushFixed = new Uint8Array(n * 2);
    }
    const px = this.pushX;
    const py = this.pushY;
    px.fill(0, 0, n);
    py.fill(0, 0, n);
    this.pushWeight.fill(0, 0, n);
    this.pushFixed.fill(0, 0, n);
    // Units in a deploy stance are rooted: others separate from them as from a structure.
    const movable = (e: Ent): boolean => e.unit && e.built && !e.hangar && !e.transitKind?.stationary && e.aegisUntil <= this.tick && e.deploy === DEPLOY_NONE && !(e.plane === 'depths' && e.path !== null && e.pathI < e.path.length);
    for (let i = 0; i < n; i++) {
      const e = ents[i]!;
      if (e.dead || e.hangar || isNeutralKind(e.kind) || !movable(e)) continue;
      const pb = PLANE_INDEX[e.plane] * this.bucketCount;
      // Search far enough for the largest body (a Spire segment) so no neighbour is missed at a bucket edge.
      const m = e.radius + MAX_BODY_RADIUS;
      const bx0 = Math.max(0, ((e.x - m) / BUCKET) | 0);
      const bx1 = Math.min(this.bucketWidth - 1, ((e.x + m) / BUCKET) | 0);
      const by0 = Math.max(0, ((e.y - m) / BUCKET) | 0);
      const by1 = Math.min(this.bucketWidth - 1, ((e.y + m) / BUCKET) | 0);
      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          for (let k = this.bucketHead[pb + by * this.bucketWidth + bx]!; k >= 0; k = this.bucketNext[k]!) {
            const o = ents[k]!;
            if (o === e || o.dead || o.plane !== e.plane || isNeutralKind(o.kind)) continue;
            if (e.plane === 'sky' && Math.abs(e.elevation - o.elevation) > e.radius + o.radius) continue;
            const j = o.slot;
            const oMovable = o.unit && o.built && o.aegisUntil <= this.tick && o.deploy === DEPLOY_NONE && !(o.plane === 'depths' && o.path !== null && o.pathI < o.path.length);
            if (oMovable && j < i) continue; // each movable pair once
            const structure = o.structure;
            if ((isArmy(e.side) && !this.hostile(e.side, o.side) && o.kind === 'bulkhead') || o.kind === 'lava_bridge') continue;
            // Moving Depths paths already bypass separation. A resting Warden must still make room
            // for a planted shield bearer rather than occupying its centre indefinitely.
            let dx = e.x - o.x;
            let dy = e.y - o.y;
            const f = structure && isStatKind(o.kind) ? this.stats[o.kind].footprint : undefined;
            let body = o.radius;
            if (f) {
              const ax = Math.abs(dx) - f.w / 2;
              const ay = Math.abs(dy) - f.h / 2;
              body = 0;
              if (ax < 0 && ay < 0) {
                // Inside a newly placed site: eject through the nearest face, measured and tied in the unit's frame
                // (toward the frame's +x/+y on a centre tie), then rotated back (signed zeros folded).
                const k = e.frame;
                const fx = canonVX(k, dx, dy);
                const fy = canonVY(k, dx, dy);
                const bx = Math.abs(fx) - f.w / 2;
                const by = Math.abs(fy) - f.h / 2;
                let ex = 0;
                let ey = 0;
                if (bx >= by) { body = -bx; ex = fx === 0 ? 1 : Math.sign(fx); }
                else { body = -by; ey = fy === 0 ? 1 : Math.sign(fy); }
                dx = rotVX(k, ex, ey) || 0;
                dy = rotVY(k, ex, ey) || 0;
                body += SITE_EJECT;
              } else {
                dx = Math.sign(dx) * Math.max(0, ax);
                dy = Math.sign(dy) * Math.max(0, ay);
              }
            }
            const reach = e.radius + body - SEP_DEADBAND;
            // Damped pushes can land exactly on the deadband; SNAP_EPS keeps rotated pairs on the same side.
            if (dx * dx + dy * dy >= reach * reach - SNAP_EPS) continue;
            const d = norm(dx, dy);
            const overlap = e.radius + body - d;
            if (d < GEOM_EPS) {
              // Choose the pair's frame by its first serial, not whichever entity the storage loop visits first.
              // Armies may be interleaved differently at rotated piles; the first body takes the direction in its
              // frame and the other its exact negation. On equal serials an army goes before neutral and two armies
              // go by relative order (opposite armies' frames differ by a half turn: either order gives the same push).
              // One owner holding two bodies of one serial (re-owned) keeps master's rule: army 0's body `e` first.
              const lo = Math.min(e.seq, o.seq);
              const hi = Math.max(e.seq, o.seq);
              const a = ((lo * SEP_TIE_PRIME_LO + hi * SEP_TIE_PRIME_HI) % SEP_TIE_DEGREES) * (Math.PI / 180);
              let first = e.seq < o.seq;
              if (e.seq === o.seq) {
                if (e.side === o.side) first = e.side === 0;
                else if (!isArmy(o.side) || !isArmy(e.side)) first = isArmy(e.side);
                else {
                  const ahead = this.rel(e.side, o.side);
                  const behind = this.rel(o.side, e.side);
                  first = ahead < behind || (ahead === behind && e.side < o.side);
                }
              }
              const k = first ? e.frame : o.frame;
              const c = dmath.cos(a);
              const s = dmath.sin(a);
              dx = first ? rotVX(k, c, s) : -rotVX(k, c, s);
              dy = first ? rotVY(k, c, s) : -rotVY(k, c, s);
            } else {
              dx /= d;
              dy /= d;
            }
            // Planar faces converge to the tolerance boundary. Pushing past it can cross the opposite face's
            // boundary in a one-cell passage, reversing the correction on the next tick.
            const fix = (overlap - SEP_DEADBAND * (structure ? 1 : SEP_UNIT_DEADBAND)) * SEP_DAMP;
            if (structure || !oMovable) {
              if (e.kind === 'warden' && o.kind === 'warden' && o.deploy !== DEPLOY_NONE && !this.hostile(e.side, o.side)) this.pushFixed[i] = 2;
              else if (!this.pushFixed[i]) this.pushFixed[i] = 1;
              this.nudge(e, i, dx * fix, dy * fix, overlap, 1);
              continue;
            }
            const eMoving = this.moved[i] === 1;
            const oMoving = this.moved[j] === 1;
            // Units holding a firing position are not shoved by others; otherwise whoever is at rest makes way,
            // and movers side-step around each other. Between equals the lighter hull gives more (mass ~ r²), so a
            // skiff makes way for a Bastion rather than both shoving alike.
            const even = e.firing === o.firing && eMoving === oMoving;
            const mass = sq(e.radius) + sq(o.radius);
            // Both shares spelled out (not 1 - the other): a twin pair visited the other way round splits identically.
            const eShare = even ? sq(o.radius) / mass : e.firing !== o.firing ? (e.firing ? 0 : 1) : eMoving ? SEP_SHARE_MOVER : SEP_SHARE_RESTING;
            const oShare = even ? sq(e.radius) / mass : 1 - eShare;
            // A planted unit never gives way: the other is pushed off it like off a wall.
            if (o.firing && !e.firing) this.pushFixed[i] = 1;
            if (e.firing && !o.firing) this.pushFixed[j] = 1;
            this.nudge(e, i, dx * fix * eShare, dy * fix * eShare, overlap, eShare);
            this.nudge(o, j, -dx * fix * oShare, -dy * fix * oShare, overlap, oShare);
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      let x = px[i]!;
      let y = py[i]!;
      if (x === 0 && y === 0) continue;
      // All contacts were measured before any push lands (a Jacobi projection). Normalize by total responsibility:
      // summing several full corrections overshoots between opposing contacts. Shares already split movable pairs,
      // so counting contacts instead would damp them twice and make dense idle clusters settle unnecessarily slowly.
      // Never amplify a partial share; single contacts keep their original correction and deep overlaps keep the cap.
      const weight = Math.max(1, this.pushWeight[i]!);
      x /= weight;
      y /= weight;
      const e = ents[i]!;
      const len = norm(x, y);
      // Opposing planar contacts can cancel to a rounding quantum; do not turn that residue into a reversal.
      if (len <= SNAP_EPS) continue;
      if (len > MAX_PUSH) {
        x *= MAX_PUSH / len;
        y *= MAX_PUSH / len;
      }
      // Quantize the push, not the sum: grid + grid is exact, while a rounded sum near 9.5 and its mirror near 38.5
      // can land one quantum apart.
      x = quantize(x);
      y = quantize(y);
      if (e.plane === 'surface' && !this.surfaceBlocked(e.side, e.x, e.y) && (this.surfaceBlocked(e.side, e.x + x, e.y + y) || !hullLineClear(this.block, e.x, e.y, e.x + x, e.y + y, e.radius, e.frame, this.size, true))) {
        // Pushed into a cliff: slide along it (keep the axis that stays clear), as a step does. Both clear: the owner's
        // canonical x axis (world y for a quarter-turned owner), so rotated twins slide alike (C4).
        const xFree = !this.surfaceBlocked(e.side, e.x + x, e.y) && hullLineClear(this.block, e.x, e.y, e.x + x, e.y, e.radius, e.frame, this.size, true);
        const yFree = !this.surfaceBlocked(e.side, e.x, e.y + y) && hullLineClear(this.block, e.x, e.y, e.x, e.y + y, e.radius, e.frame, this.size, true);
        if (xFree && (e.frame % 2 === 0 || !yFree)) y = 0;
        else if (yFree) x = 0;
        else continue;
      } else if (e.plane === 'orbit' && this.derelict) {
        // Pushed against the ruin: slide along the wall face instead of into it.
        this.derelictClip(e, x, y);
        x = quantize(route.x);
        y = quantize(route.y);
        if (x === 0 && y === 0) continue;
      }
      let nx = clampPos(e.x + x, this.size);
      let ny = clampPos(e.y + y, this.size);
      if (e.plane === 'depths') {
        // The owner's own cell (cellFor): a unit exactly on a cell edge stays in its rotated twin's cell.
        const c = cellFor(e.frame, e.x, e.y, this.size);
        const cx = c % this.size;
        const cy = (c - cx) / this.size;
        const next = cellFor(e.frame, nx, ny, this.size);
        const clearsShield = this.pushFixed[i] === 2 && this.depthsOpen(next, this.gateBit(e.side)) &&
          (next === c || this.depthsSight(e.x, e.y, next, e.frame, this.gateBit(e.side)));
        if (!clearsShield) {
          nx = Math.min(cx + DEPTHS_CELL_MAX, Math.max(cx + DEPTHS_CELL_MIN, nx));
          ny = Math.min(cy + DEPTHS_CELL_MAX, Math.max(cy + DEPTHS_CELL_MIN, ny));
        }
      } else if (this.pushFixed[i]) {
        // Contact damping against a body that never gives way (a structure, a pinned or planted unit): momentum into
        // it is lost (an inelastic contact), so a unit (above all a heavy, slow-turning hull) stops pressing into it
        // instead of being pushed back out every tick. Bodies that do give way keep being shoved aside.
        const l = norm(x, y);
        const into = (e.vx * x + e.vy * y) / l;
        if (into < 0) {
          e.vx = quantize(e.vx - (into * x) / l);
          e.vy = quantize(e.vy - (into * y) / l);
        }
      }
      e.x = clampPos(nx, this.size);
      e.y = clampPos(ny, this.size);
      if (e.plane === 'depths') e.cell = cellFor(e.frame, e.x, e.y, this.size);
    }
  }

  /**
   * Accumulate a separation push. A moving unit is never pushed back along its path: the backward part turns into
   * a side-step of the same size (it steers around), unless the bodies already overlap deeply. `share` is the
   * dimensionless responsibility already applied to (x, y): 1 against a fixed body, otherwise this pair's split.
   */
  nudge(this: Sim, e: Ent, i: number, x: number, y: number, overlap: number, share: number): void {
    if (x === 0 && y === 0) return;
    this.pushWeight[i]! += share;
    if (this.moved[i] === 1 && overlap < NUDGE_DEEP) {
      const mx = this.moveX[i]!;
      const my = this.moveY[i]!;
      const along = x * mx + y * my;
      if (along < 0) {
        const mag = norm(x, y);
        let lx = x - along * mx;
        let ly = y - along * my;
        const lat = norm(lx, ly);
        if (lat < GEOM_EPS) {
          // Head-on: pick a side deterministically.
          lx = e.seq % 2 ? -my : my;
          ly = e.seq % 2 ? mx : -mx;
        } else {
          lx /= lat;
          ly /= lat;
        }
        x = lx * mag;
        y = ly * mag;
      }
    }
    this.pushX[i]! += x;
    this.pushY[i]! += y;
  }
}
