/** Client-only projectile math. World distances are tiles; times in the renderer are milliseconds. */
export type Trajectory = 'linear' | 'arc' | 'fall';

export type OrbitWeapon = 'lancer' | 'skiff' | 'bastion';

/** Cosmetic envelopes only: a heavy stuttering train, a crisp twin tap, and a cool rapid PD burst. */
export function orbitPulse(age: number, kind: OrbitWeapon): number {
  if (age < 0) return 0;
  if (kind === 'lancer') {
    if (age >= 620) return 0;
    const phase = age % 105;
    return phase < 66 ? (0.65 + 0.35 * (1 - phase / 66)) * (1 - age / 850) : 0.08;
  }
  if (kind === 'skiff') {
    const phase = age < 58 ? age : age - 82;
    return phase >= 0 && phase < 58 ? 1 - phase / 58 : 0;
  }
  if (age >= 170) return 0;
  return age % 48 < 29 ? 1 - (age % 48) / 40 : 0;
}

/**
 * Writes a position into caller-owned storage. `u` is normalized authoritative flight time, not distance.
 * Shells use a parabola whose apex is `arc` tiles above the straight chord. Bombs retain linear horizontal
 * drift while accelerating vertically (u²): easing all three axes would incorrectly accelerate sideways.
 * No gravity simulation or homing is inferred from an FX event; both endpoints remain server-owned.
 */
export function projectilePoint(out: Float64Array, trajectory: Trajectory, u: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, arc: number): void {
  const t = Math.max(0, Math.min(1, u));
  out[0] = sx + (ex - sx) * t;
  out[1] = sy + (ey - sy) * (trajectory === 'fall' ? t * t : t) + (trajectory === 'arc' ? 4 * arc * t * (1 - t) : 0);
  out[2] = sz + (ez - sz) * t;
}

/**
 * Writes a column-major Three instance matrix for a +Z-aligned unit shape spanning tail→head.
 * The secondary axis switches near vertical flight to keep the cross product well conditioned.
 * Coincident endpoints produce a finite zero-length instance, never an invented visible direction.
 * `width`/`height` are world-space diameters; octahedra therefore use radius 0.5 before this transform.
 */
export function projectileSegment(out: Float32Array, index: number, tx: number, ty: number, tz: number, hx: number, hy: number, hz: number, width: number, height = width): void {
  let dx = hx - tx, dy = hy - ty, dz = hz - tz;
  const length = Math.hypot(dx, dy, dz);
  if (length > 1e-8) { dx /= length; dy /= length; dz /= length; }
  else { dx = 0; dy = 0; dz = 1; }
  // normalize(up × direction); use X as 'up' near vertical, Y otherwise.
  let xx = Math.abs(dy) > 0.95 ? 0 : dz;
  let xy = Math.abs(dy) > 0.95 ? -dz : 0;
  let xz = Math.abs(dy) > 0.95 ? dy : -dx;
  const inv = 1 / Math.hypot(xx, xy, xz);
  xx *= inv; xy *= inv; xz *= inv;
  const yx = dy * xz - dz * xy, yy = dz * xx - dx * xz, yz = dx * xy - dy * xx;
  const o = index * 16;
  out[o] = xx * width; out[o + 1] = xy * width; out[o + 2] = xz * width; out[o + 3] = 0;
  out[o + 4] = yx * height; out[o + 5] = yy * height; out[o + 6] = yz * height; out[o + 7] = 0;
  out[o + 8] = dx * length; out[o + 9] = dy * length; out[o + 10] = dz * length; out[o + 11] = 0;
  out[o + 12] = (hx + tx) / 2; out[o + 13] = (hy + ty) / 2; out[o + 14] = (hz + tz) / 2; out[o + 15] = 1;
}
