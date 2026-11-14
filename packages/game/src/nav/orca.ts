/**
 * ORCA (Optimal Reciprocal Collision Avoidance; van den Berg et al., the RVO2 algorithm) for circular bodies in the
 * plane. Each neighbour turns into a half-plane of allowed velocities (the part of the velocity obstacle over the time
 * horizon this body is responsible for: half against bodies that avoid back, all of it against bodies that do not);
 * the new velocity is the one closest to the preferred velocity inside every half-plane and the speed circle (a 2D
 * linear program solved incrementally), or the least-violating one when they leave no room. The optimum of a convex
 * problem does not depend on the order the constraints come in, so mirrored bodies get mirrored answers.
 * Buffers are module-level and reused (the sim is single-threaded): no allocation per call.
 */
import { norm } from '../util/math.ts';

/** Most neighbours one body considers (the nearest ones). */
export const ORCA_MAX_NEIGHBOURS = 24;

/** LP tolerance (tiles/tick): nearly parallel constraint lines and infeasibility margins below this count as zero. */
const EPS = 1e-6;
const cap = ORCA_MAX_NEIGHBOURS;
const lpx = new Float64Array(cap);
const lpy = new Float64Array(cap);
const ldx = new Float64Array(cap);
const ldy = new Float64Array(cap);
const ppx = new Float64Array(cap);
const ppy = new Float64Array(cap);
const pdx = new Float64Array(cap);
const pdy = new Float64Array(cap);
let lines = 0;
/** result of the last solve */
export const orcaOut = { x: 0, y: 0 };

/** Start a new body: clear its constraints. */
export function orcaBegin(): void {
  lines = 0;
}

/**
 * Add the constraint for one neighbour. rel = neighbour position − own position, relVel = own velocity − neighbour
 * velocity, r = sum of radii, tau = time horizon (ticks), share = this body's share of the avoidance (0.5 or 1).
 * (vx, vy) is the body's current velocity; velocities are per tick, the time step is one tick.
 */
export function orcaNeighbour(vx: number, vy: number, rx: number, ry: number, rvx: number, rvy: number, r: number, tau: number, share: number): void {
  if (lines >= cap) return;
  const distSq = rx * rx + ry * ry;
  const rSq = r * r;
  let dirX: number;
  let dirY: number;
  let ux: number;
  let uy: number;
  if (distSq > rSq) {
    // No collision yet: the velocity obstacle is a cone truncated by a circle at rel / tau.
    const wx = rvx - rx / tau;
    const wy = rvy - ry / tau;
    const wLenSq = wx * wx + wy * wy;
    const dot1 = wx * rx + wy * ry;
    if (dot1 < 0 && dot1 * dot1 > rSq * wLenSq) {
      // Project on the cut-off circle.
      const wLen = Math.sqrt(wLenSq);
      const nx = wx / wLen;
      const ny = wy / wLen;
      dirX = ny;
      dirY = -nx;
      ux = (r / tau - wLen) * nx;
      uy = (r / tau - wLen) * ny;
    } else {
      // Project on a leg of the cone.
      const leg = Math.sqrt(distSq - rSq);
      if (rx * wy - ry * wx > 0) {
        dirX = (rx * leg - ry * r) / distSq;
        dirY = (rx * r + ry * leg) / distSq;
      } else {
        dirX = -(rx * leg + ry * r) / distSq;
        dirY = -(-rx * r + ry * leg) / distSq;
      }
      const dot2 = rvx * dirX + rvy * dirY;
      ux = dot2 * dirX - rvx;
      uy = dot2 * dirY - rvy;
    }
  } else {
    // Already overlapping: get apart within one tick.
    const wx = rvx - rx;
    const wy = rvy - ry;
    const wLen = norm(wx, wy);
    if (wLen < EPS) return;
    const nx = wx / wLen;
    const ny = wy / wLen;
    dirX = ny;
    dirY = -nx;
    ux = (r - wLen) * nx;
    uy = (r - wLen) * ny;
  }
  lpx[lines] = vx + share * ux;
  lpy[lines] = vy + share * uy;
  ldx[lines] = dirX;
  ldy[lines] = dirY;
  lines++;
}

function lp1(px: Float64Array, py: Float64Array, dx: Float64Array, dy: Float64Array, no: number, radius: number, ox: number, oy: number, dirOpt: boolean): boolean {
  const dot = px[no]! * dx[no]! + py[no]! * dy[no]!;
  const disc = dot * dot + radius * radius - (px[no]! * px[no]! + py[no]! * py[no]!);
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  let tLeft = -dot - sq;
  let tRight = -dot + sq;
  for (let i = 0; i < no; i++) {
    const denom = dx[no]! * dy[i]! - dy[no]! * dx[i]!;
    const numer = dx[i]! * (py[no]! - py[i]!) - dy[i]! * (px[no]! - px[i]!);
    if (Math.abs(denom) <= EPS) {
      if (numer < 0) return false;
      continue;
    }
    const t = numer / denom;
    if (denom >= 0) tRight = Math.min(tRight, t);
    else tLeft = Math.max(tLeft, t);
    if (tLeft > tRight) return false;
  }
  let t: number;
  if (dirOpt) t = ox * dx[no]! + oy * dy[no]! > 0 ? tRight : tLeft;
  else t = Math.max(tLeft, Math.min(tRight, dx[no]! * (ox - px[no]!) + dy[no]! * (oy - py[no]!)));
  orcaOut.x = px[no]! + t * dx[no]!;
  orcaOut.y = py[no]! + t * dy[no]!;
  return true;
}

function lp2(px: Float64Array, py: Float64Array, dx: Float64Array, dy: Float64Array, n: number, radius: number, ox: number, oy: number, dirOpt: boolean): number {
  const oLen = norm(ox, oy);
  if (dirOpt) {
    orcaOut.x = ox * radius;
    orcaOut.y = oy * radius;
  } else if (oLen > radius) {
    orcaOut.x = (ox / oLen) * radius;
    orcaOut.y = (oy / oLen) * radius;
  } else {
    orcaOut.x = ox;
    orcaOut.y = oy;
  }
  for (let i = 0; i < n; i++) {
    if (dx[i]! * (py[i]! - orcaOut.y) - dy[i]! * (px[i]! - orcaOut.x) > 0) {
      const tx = orcaOut.x;
      const ty = orcaOut.y;
      if (!lp1(px, py, dx, dy, i, radius, ox, oy, dirOpt)) {
        orcaOut.x = tx;
        orcaOut.y = ty;
        return i;
      }
    }
  }
  return n;
}

function lp3(begin: number, radius: number): void {
  let distance = 0;
  for (let i = begin; i < lines; i++) {
    if (ldx[i]! * (lpy[i]! - orcaOut.y) - ldy[i]! * (lpx[i]! - orcaOut.x) <= distance) continue;
    let m = 0;
    for (let j = 0; j < i; j++) {
      const det = ldx[i]! * ldy[j]! - ldy[i]! * ldx[j]!;
      if (Math.abs(det) <= EPS) {
        if (ldx[i]! * ldx[j]! + ldy[i]! * ldy[j]! > 0) continue;
        ppx[m] = 0.5 * (lpx[i]! + lpx[j]!);
        ppy[m] = 0.5 * (lpy[i]! + lpy[j]!);
      } else {
        const t = (ldx[j]! * (lpy[i]! - lpy[j]!) - ldy[j]! * (lpx[i]! - lpx[j]!)) / det;
        ppx[m] = lpx[i]! + t * ldx[i]!;
        ppy[m] = lpy[i]! + t * ldy[i]!;
      }
      const ddx = ldx[j]! - ldx[i]!;
      const ddy = ldy[j]! - ldy[i]!;
      const dl = norm(ddx, ddy);
      pdx[m] = ddx / dl;
      pdy[m] = ddy / dl;
      m++;
    }
    const tx = orcaOut.x;
    const ty = orcaOut.y;
    if (lp2(ppx, ppy, pdx, pdy, m, radius, -ldy[i]!, ldx[i]!, true) < m) {
      orcaOut.x = tx;
      orcaOut.y = ty;
    }
    distance = ldx[i]! * (lpy[i]! - orcaOut.y) - ldy[i]! * (lpx[i]! - orcaOut.x);
  }
}

/** The new velocity (into orcaOut): closest to (prefX, prefY) within `maxSpeed` and every constraint added. */
export function orcaSolve(prefX: number, prefY: number, maxSpeed: number): void {
  const fail = lp2(lpx, lpy, ldx, ldy, lines, maxSpeed, prefX, prefY, false);
  if (fail < lines) lp3(fail, maxSpeed);
}
