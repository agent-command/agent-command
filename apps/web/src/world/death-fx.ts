/**
 * The death player: one runtime that executes a kind's death profile (`death-profiles.ts`) from a death record in the
 * view's fog-filtered `fx`. It owns no per-kind look; every number comes from the profile and its plane's variant.
 *
 * - **Records only.** A death plays only when the view lists its record: the server admits a death to its owner, and
 *   to anyone else only with sight of the spot (`agent/present.ts` fx). Nothing here reads anything else.
 * - **Corpse.** When the record's unit was drawn (`Entities` adopts the removed track), its model stays for the
 *   profile's `collapse` or `wreck` stage. The fog may close over the spot meanwhile (the dying unit was its last eye;
 *   inside a storm, the only one): the record already proved the view may see the death, so its particles skip the
 *   fog fade (`REVEALED`) and a Sky death keeps a storm opening until it is over (`openings`).
 * - **Clock.** A death starts on the frame its tick reaches the screen (`renderTick`), with the audio director's cue.
 * - **Budget.** A fixed slot pool (`SLOTS`; the quality tier's `deaths.cap` of them in use): no allocation per death
 *   or per frame. Past the cap a death gets a one-shot burst, no corpse or lingering stages. The tier also scales
 *   particle counts (`density`) and smoke/scorch durations (`linger`).
 * - **Reduced motion:** the model fades out in place; no particles, rings, wreck or shake.
 */
import { Color, Vector4 } from 'three/webgpu';
import { PLANE_Y, type Kind, type Plane, type View } from '@agent-command/game/contract';
import { GROUND, hash2, sideColor, wx, wz } from './common.ts';
import { PIDX, RING } from './combat.ts';
import { DEATH_PLANES, deathProfile, deathScale, type DeathPigment, type DeathPlaneEnv, type DeathProfile, type DeathStage } from './death-profiles.ts';
import type { Track } from './entities.ts';
import type { FogField } from './fog.ts';
import { REVEALED, type ParticlePool } from './gpu-particles.ts';
import { QUALITY, type Quality } from './quality.ts';
import { SPIRE_HEIGHT, spireBaseY } from './spires.ts';
import { TerrainField } from './terrain.ts';

type FxEntry = View['fx'][number];
type RingStyle = (typeof RING)[keyof typeof RING];

/** The ring decal pool (`Combat`'s rings), timestamped on the `performance.now()` clock. */
export interface RingSink {
  add(plane: number, x: number, y: number, z: number, r0: number, r1: number, t0: number, dur: number, c: Color, a0: number, style?: RingStyle): void;
}

export interface DeathPools {
  readonly sparks: ParticlePool;
  readonly smoke: ParticlePool;
  readonly debris: ParticlePool;
  readonly rings: RingSink;
}

/** Slots allocated once: the largest tier cap. */
export const DEATH_SLOTS = Math.max(QUALITY.full.deaths.cap, QUALITY.phone.deaths.cap);
/** Emission-debt slots per program; the last one is the falling wreck's trail. */
const MAX_STAGES = 16;
/** Stages a profile program (main, or a wreck's landing) may hold: one fired bit and one debt slot each. */
export const DEATH_STAGE_CAP = MAX_STAGES - 1;
/** Reduced motion: the model fades out over this long, and nothing else plays. */
export const REDUCED_FADE_MS = 450;
/** A slot never outlives this, whatever its stages say (ms). */
const MAX_LIFE_MS = 12000;
/** Storm opening round a dying Sky body: × its drawn scale (world units), closing over the last share of the death. */
const OPENING = 1.25;
const OPEN_CLOSE = 0.3;
/** World height of a body's centre above its track's `wy`, per unit of drawn scale. */
export const BODY_LIFT = 0.35;
/** Nose-down pitch a falling wreck settles to (rad). */
const WRECK_DIVE = 1.15;
/** A wreck stage on a plane with nothing below (an aircraft dying off the Sky) fades in place over this long (ms). */
const WRECK_FADE_MS = 600;

const C = (hex: string) => new Color(hex);
const PIGMENT: Readonly<Record<Exclude<DeathPigment, 'side'>, Color>> = {
  // emissive (> 1): the only part of a death that blooms
  flash: new Color(2.4, 1.9, 1.3),
  fire: C('#ec5a24'), ember: C('#d4401a'), smoke: C('#8c8499'), soot: C('#3d3735'), dust: C('#b8996e'),
  debris: C('#4a4038'), spark: C('#f2b552'), cold: C('#8bdaef'), splash: C('#d8f0ff'),
};
const RING_STYLE: Readonly<Record<'ink' | 'wash' | 'dash', RingStyle>> = { ink: 0, wash: 1, dash: 3 };

/** One playing death. Pose fields are read by `Entities` for the corpse model. */
export class DeathSlot {
  live = false;
  started = false;
  fx: FxEntry | undefined = undefined;
  tick = 0;
  kind: Kind = 'trooper';
  plane: Plane = 'surface';
  side: Color = PIGMENT.debris;
  profile: DeathProfile = deathProfile('trooper');
  /** Stage scale (`deathScale`) and the corpse's drawn model scale. */
  scale = 1;
  model = 1;
  /** Deterministic jitter seed (record tick and spot). */
  seed = 0;
  corpse: Track | undefined = undefined;
  /** Anchor: the body centre in world units (the corpse's drawn pose, else the record's spot) and the floor under it. */
  bx = 0; by = 0; bz = 0; floor = 0;
  heading = 0;
  /** `performance.now()` at start, and ms after it when the main program is over. */
  t0 = 0;
  end = 0;
  fired = 0;
  readonly debt = new Float64Array(MAX_STAGES);
  /** Wreck: falling body (world units, units/s), its landing height and drop. */
  falling = false;
  px = 0; py = 0; pz = 0; vx = 0; vy = 0; vz = 0;
  landY = 0;
  drop = 1;
  water = false;
  /** Landing program: started at `tl`, at world (lx, ly, lz) on the plane below. */
  landed = false;
  tl = 0;
  landEnd = 0;
  landFired = 0;
  landSeen = false;
  lx = 0; ly = 0; lz = 0;
  readonly landDebt = new Float64Array(MAX_STAGES);
  /** Corpse pose against its drawn base: world offset, extra pitch/bank/yaw (rad), scale and height factors, opacity,
   * char (0..1 toward ink) and the plane it falls toward (its fade). */
  ox = 0; oy = 0; oz = 0; pitch = 0; bank = 0; yaw = 0; scaleK = 1; build = 1; alpha = 1; char = 0;
  below: Plane | undefined = undefined;

  resetPose(): void {
    this.ox = this.oy = this.oz = this.pitch = this.bank = this.yaw = this.char = 0;
    this.scaleK = this.build = this.alpha = 1;
    this.below = undefined;
  }
}

/** Duration (ms) a stage keeps the slot alive after its start. */
function stageMs(s: DeathStage, linger: number): number {
  switch (s.kind) {
    case 'smoke': return s.ms * linger;
    case 'collapse': return s.ms;
    // a wreck with no plane below fades in place for as long (`DeathPlayer.pose`); a falling one holds its slot itself
    case 'wreck': return WRECK_FADE_MS;
    default: return 0;
  }
}

function programEnd(stages: readonly DeathStage[] | undefined, linger: number): number {
  let end = 0;
  if (stages) for (let i = 0; i < stages.length; i++) end = Math.max(end, stages[i]!.at + stageMs(stages[i]!, linger));
  return end;
}

export class DeathPlayer {
  readonly slots: readonly DeathSlot[] = Array.from({ length: DEATH_SLOTS }, () => new DeathSlot());
  /** Storm openings (world x, y, z, radius) round dying Sky bodies, the first `openCount` live (`WeatherLayer`). */
  readonly openings: readonly Vector4[] = Array.from({ length: DEATH_SLOTS }, () => new Vector4());
  openCount = 0;
  /** Camera shake requested since `Combat` last took it, and the focused plane it is judged against. */
  shake = 0;
  focus: Plane = 'surface';
  private cap = QUALITY.full.deaths.cap;
  private density = 1;
  private linger = 1;
  private readonly pools: DeathPools;
  private readonly size: number;
  private readonly terrain: TerrainField;
  private readonly fog: FogField | undefined;
  private readonly motion: () => boolean;
  /** `performance.now()` of the last `frame`. */
  private now = 0;
  /** The slot a one-shot burst past the cap is run through (never live). */
  private readonly scratch = new DeathSlot();

  constructor(pools: DeathPools, size: number, terrain: TerrainField, fog: FogField | undefined, reducedMotion: () => boolean) {
    this.pools = pools;
    this.size = size;
    this.terrain = terrain;
    this.fog = fog;
    this.motion = reducedMotion;
  }

  /** Take the render tier's death budget (`Quality.deaths`). */
  configure(q: Quality): void {
    this.cap = Math.min(DEATH_SLOTS, q.deaths.cap);
    this.density = q.deaths.density;
    this.linger = q.deaths.linger;
  }

  /** Live slots (diagnostics and tests). */
  get active(): number {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]!.live) n++;
    return n;
  }

  private slotOf(f: FxEntry): DeathSlot | undefined {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]!.live && this.slots[i]!.fx === f) return this.slots[i];
    return undefined;
  }

  private claim(f: FxEntry): DeathSlot | undefined {
    let used = 0;
    let free: DeathSlot | undefined;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.live) used++;
      else free ??= s;
    }
    if (!free || used >= this.cap) return undefined;
    const kind = f.subject ?? 'trooper';
    free.live = true;
    free.started = free.falling = free.landed = false;
    free.fx = f;
    free.tick = f.tick;
    free.kind = kind;
    free.plane = f.plane;
    free.side = f.side ? sideColor(f.side) : PIGMENT.debris;
    free.profile = deathProfile(kind);
    free.scale = deathScale(kind);
    free.model = 1;
    free.seed = hash2(f.tick * 31 + Math.round(f.x * 10), Math.round(f.y * 10));
    free.corpse = undefined;
    free.fired = free.landFired = 0;
    free.debt.fill(0);
    free.landDebt.fill(0);
    free.resetPose();
    return free;
  }

  /**
   * A removed track whose death record `f` this view lists: keep its model for the death. False when the pool is
   * full (the track simply goes, as without a death player).
   */
  adopt(f: FxEntry, tr: Track): boolean {
    if (this.slotOf(f)) return true;
    const d = this.claim(f);
    if (!d) return false;
    d.corpse = tr;
    d.heading = tr.heading;
    d.model = tr.scale;
    this.place(d, wx(tr.rx, this.size), tr.wy + BODY_LIFT * tr.scale, wz(tr.ry, this.size), tr.scale);
    return true;
  }

  /**
   * A new death record, anchored at world (x, y, z) (`Combat`'s effect anchor) unless a corpse already anchors it;
   * `now`: the ms its tick is on screen, for a one-shot burst past the cap.
   */
  add(f: FxEntry, x: number, y: number, z: number, now: number): void {
    if (this.slotOf(f)) return;
    const d = this.claim(f);
    const profile = deathProfile(f.subject ?? 'trooper');
    const floor = this.floorAt(f.plane, f.x, f.y);
    if (profile.anchor === 'spire') y = spireBaseY(f.plane, f.x, f.y, this.terrain) + SPIRE_HEIGHT[f.plane];
    if (!d) {
      if (!this.motion()) this.burst(f, profile, x, y, z, floor, now);
      return;
    }
    d.bx = x; d.by = y; d.bz = z;
    d.floor = profile.anchor === 'spire' ? spireBaseY(f.plane, f.x, f.y, this.terrain) : floor;
  }

  /** The corpse's drawn body centre this frame (`Entities`), and its drawn model scale. */
  place(d: DeathSlot, x: number, y: number, z: number, model: number): void {
    d.bx = x; d.by = y; d.bz = z;
    d.model = model;
    const tx = x + this.size / 2, ty = z + this.size / 2;
    d.floor = this.floorAt(d.plane, tx, ty);
  }

  private floorAt(plane: Plane, x: number, y: number): number {
    return plane === 'surface' ? PLANE_Y.surface + this.terrain.groundAt(x, y) : PLANE_Y[plane] + GROUND[plane];
  }

  frame(now: number, dt: number, renderTick: number): void {
    const reduced = this.motion();
    this.now = now;
    for (let i = 0; i < this.slots.length; i++) {
      const d = this.slots[i]!;
      if (!d.live) continue;
      if (!d.started) {
        if (renderTick < d.tick) continue;
        this.start(d, now, reduced);
      }
      const el = now - d.t0;
      if (reduced) {
        d.alpha = Math.max(0, 1 - el / REDUCED_FADE_MS);
        if (el >= REDUCED_FADE_MS) this.free(d);
        continue;
      }
      const env = DEATH_PLANES[d.plane];
      d.fired = this.program(d, d.profile.stages, el, d.fired, d.debt, d.plane, env, d.bx, d.by, d.bz, d.floor, true, now, dt);
      this.pose(d, el, env, now, dt);
      if (d.landed) {
        const below = env.below!;
        d.landFired = this.program(d, d.water ? d.profile.splash : d.profile.landing, now - d.tl, d.landFired, d.landDebt, below, DEATH_PLANES[below], d.lx, d.ly, d.lz, d.ly, false, now, dt);
      }
      const done = el >= d.end && !d.falling && (!d.landed || now - d.tl >= d.landEnd);
      if (done || el >= MAX_LIFE_MS) this.free(d);
    }
  }

  /**
   * Refill `openings` from the live slots (the storm pass reads them before this frame's `frame`): a death adopted
   * at ingest opens its spot on the very frame its track's own opening closes.
   */
  collectOpenings(): void {
    this.openCount = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const d = this.slots[i]!;
      if (d.live) this.open(d, d.started ? this.now - d.t0 : 0);
    }
  }

  private start(d: DeathSlot, now: number, reduced: boolean): void {
    d.started = true;
    d.t0 = now;
    d.end = reduced ? REDUCED_FADE_MS : programEnd(d.profile.stages, this.linger);
    d.landEnd = Math.max(programEnd(d.profile.landing, this.linger), programEnd(d.profile.splash, this.linger));
    if (!reduced) this.shake = Math.max(this.shake, d.profile.shake * (this.focus === d.plane ? 1 : 1 / 3));
  }

  private free(d: DeathSlot): void {
    d.live = false;
    d.corpse = undefined;
    d.fx = undefined;
  }

  /**
   * A Sky body's storm opening while its death plays: round the falling wreck, else round the body, closing over
   * the last `OPEN_CLOSE` share of the death so the storm has the spot again when it is over.
   */
  private open(d: DeathSlot, el: number): void {
    if (d.plane !== 'sky' || d.landed || this.openCount >= this.openings.length) return;
    let r = OPENING * Math.max(d.model, d.scale);
    if (d.falling) {
      this.openings[this.openCount++]!.set(d.px, d.py, d.pz, r);
      return;
    }
    const closing = d.end * (1 - OPEN_CLOSE);
    if (d.started && el > closing) r *= Math.max(0, 1 - (el - closing) / Math.max(1, d.end - closing));
    if (r > 0) this.openings[this.openCount++]!.set(d.bx + d.ox, d.by + d.oy, d.bz + d.oz, r);
  }

  /** Model stages: the collapse pose, or the wreck's fall (then its landing program). */
  private pose(d: DeathSlot, el: number, env: DeathPlaneEnv, now: number, dt: number): void {
    const stages = d.profile.stages;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i]!;
      if (el < s.at) continue;
      if (s.kind === 'collapse' || (s.kind === 'wreck' && env.below === undefined)) {
        const c = s.kind === 'collapse' ? s : undefined;
        const ms = c ? c.ms : WRECK_FADE_MS;
        const k = Math.min(1, (el - s.at) / ms);
        const e = 1 - (1 - k) * (1 - k);
        const side = d.seed < 0.5 ? -1 : 1;
        d.pitch = (c?.tilt ?? 0) * e * side;
        d.bank = (c?.tilt ?? 0) * e * 0.35 * -side;
        d.yaw = (c?.spin ?? 0) * e * side;
        d.oy = -(c?.sink ?? 0) * e * d.model * 2 * BODY_LIFT;
        d.build = 1 - (c?.squash ?? 0) * e;
        d.scaleK = 1 - (1 - (c?.shrink ?? 1)) * e;
        d.char = (c?.char ?? 0.5) * e;
        const fade = c?.fade ?? 1;
        d.alpha = k < 1 - fade ? 1 : Math.max(0, (1 - k) / Math.max(fade, 1e-3));
      } else if (s.kind === 'wreck') this.fall(d, s, env, now, dt);
    }
  }

  private fall(d: DeathSlot, s: Extract<DeathStage, { kind: 'wreck' }>, env: DeathPlaneEnv, now: number, dt: number): void {
    const below = env.below!;
    if (d.landed) {
      d.alpha = 0;
      return;
    }
    if (!d.falling) {
      d.falling = true;
      d.below = below;
      d.px = d.bx; d.py = d.by; d.pz = d.bz;
      d.vx = Math.cos(d.heading) * s.drift * d.scale;
      d.vz = Math.sin(d.heading) * s.drift * d.scale;
      d.vy = s.pop;
      const tx = d.px + this.size / 2, ty = d.pz + this.size / 2;
      const water = below === 'surface' ? this.terrain.waterAt(tx, ty) : NaN;
      d.water = !Number.isNaN(water);
      d.landY = d.water ? PLANE_Y.surface + water : this.floorAt(below, tx, ty);
      d.drop = Math.max(1, d.py - d.landY);
    }
    d.vy -= s.gravity * dt;
    d.px += d.vx * dt;
    d.py += d.vy * dt;
    d.pz += d.vz * dt;
    const tx = d.px + this.size / 2, ty = d.pz + this.size / 2;
    // the plane below keeps its own fog: a wreck falling into unseen ground fades out before it lands
    const seen = !this.fog || this.fog.tileVisible(below, tx, ty);
    const k = Math.min(1, Math.max(0, 1 - (d.py - d.landY) / d.drop));
    d.ox = d.px - d.bx; d.oy = d.py - d.by; d.oz = d.pz - d.bz;
    d.pitch = -WRECK_DIVE * Math.sqrt(k);
    d.bank += s.spin * dt;
    d.char = 0.6 + 0.3 * k;
    d.alpha = seen ? 1 : Math.min(1, Math.max(0, (1 - k) / 0.35));
    // a smoke trail, emitted on the fall's own clock
    let debt = d.debt[MAX_STAGES - 1]! + s.trail * this.density * dt;
    for (; debt >= 1; debt--) {
      const u = hash2(d.seed * 977 + debt * 13, now);
      this.pools.smoke.spawn(PIDX[d.plane] + REVEALED, d.px + (u - 0.5) * 0.2, d.py + 0.1, d.pz + (0.5 - u) * 0.2, (u - 0.5) * 0.3, 0.4, 0, 1.3 * this.linger, 0.18 * d.scale, 0.6 * d.scale, u > 0.7 ? PIGMENT.fire : PIGMENT.soot, 0.7, 0, 0.8);
    }
    d.debt[MAX_STAGES - 1] = debt;
    if (d.py > d.landY) return;
    d.falling = false;
    d.landed = true;
    d.tl = now;
    d.lx = d.px; d.ly = d.landY; d.lz = d.pz;
    d.landSeen = seen;
    d.alpha = 0;
  }

  /**
   * Run a stage program at elapsed `el` ms: fire due one-shots once (bit i of `fired`), emit lingering columns.
   * `reveal`: particles skip the fog fade (the dying body's own plane; a landing below keeps that plane's fog).
   */
  private program(d: DeathSlot, stages: readonly DeathStage[] | undefined, el: number, fired: number, debt: Float64Array, plane: Plane, env: DeathPlaneEnv, x: number, y: number, z: number, floor: number, reveal: boolean, now: number, dt: number): number {
    if (!stages) return fired;
    // a landing nobody here can see leaves no decal either (rings ignore the fog)
    const decals = reveal || d.landSeen;
    for (let i = 0; i < stages.length && i < DEATH_STAGE_CAP; i++) {
      const s = stages[i]!;
      if (el < s.at) continue;
      if (s.kind === 'smoke') {
        if (el <= s.at + s.ms * this.linger) debt[i] = this.column(d, s, i, (el - s.at) / (s.ms * this.linger), debt[i]! + s.rate * this.density * dt, plane, env, x, y, z, floor, reveal, now);
        continue;
      }
      if (s.kind === 'collapse' || s.kind === 'wreck' || fired & (1 << i)) continue;
      fired |= 1 << i;
      this.once(d, s, i, plane, env, x, y, z, floor, reveal, decals, now);
    }
    return fired;
  }

  /** Past the cap: every one-shot stage at once, no corpse or lingering stage. */
  private burst(f: FxEntry, profile: DeathProfile, x: number, y: number, z: number, floor: number, now: number): void {
    const d = this.scratch;
    d.kind = f.subject ?? 'trooper';
    d.scale = deathScale(d.kind);
    d.seed = hash2(f.tick * 31 + Math.round(f.x * 10), Math.round(f.y * 10));
    d.side = f.side ? sideColor(f.side) : PIGMENT.debris;
    d.landSeen = true;
    const env = DEATH_PLANES[f.plane];
    for (let i = 0; i < profile.stages.length; i++) {
      const s = profile.stages[i]!;
      if (s.kind !== 'smoke' && s.kind !== 'collapse' && s.kind !== 'wreck') this.once(d, s, i, f.plane, env, x, y, z, floor, true, true, now);
    }
  }

  private count(n: number): number {
    return n > 0 ? Math.max(1, Math.round(n * this.density)) : 0;
  }

  private pigment(d: DeathSlot, p: DeathPigment | undefined, fallback: Color): Color {
    return p === undefined ? fallback : p === 'side' ? d.side : PIGMENT[p];
  }

  /** Upward speed that keeps a ballistic rise (gravity `g`) or a dragged drift (`drag`) under the plane's ceiling. */
  private rise(vy: number, y: number, floor: number, env: DeathPlaneEnv, g: number, drag: number): number {
    if (!Number.isFinite(env.ceiling)) return vy;
    const room = Math.max(0, floor + env.ceiling - y);
    return Math.min(vy, g > 0 ? Math.sqrt(2 * g * room) : room * Math.max(drag, 0.5));
  }

  private once(d: DeathSlot, s: DeathStage, stage: number, plane: Plane, env: DeathPlaneEnv, x: number, y: number, z: number, floor: number, reveal: boolean, decals: boolean, now: number): void {
    const P = PIDX[plane] + (reveal ? REVEALED : 0);
    const R = PIDX[plane];
    const k = d.scale;
    const { sparks, smoke, debris, rings } = this.pools;
    // jitter: hash2(J + i, salt), deterministic per death, stage and particle
    const J = d.seed * 1013 + stage * 31;
    switch (s.kind) {
      case 'flash': {
        const a = hash2(J, 1) * Math.PI * 2, r = (s.spread ?? 0) * k * env.spread;
        sparks.spawn(P, x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, 0, 0, 0, s.ms / 1000, 0.3 * s.size * k, s.size * k, this.pigment(d, s.pigment, PIGMENT.flash), 1);
        return;
      }
      case 'fireball': {
        const a0 = hash2(J, 2) * Math.PI * 2, off = (s.spread ?? 0) * k * env.spread;
        const cx = x + Math.cos(a0) * off, cz = z + Math.sin(a0) * off;
        const n = this.count(s.lobes);
        const spread = s.size * k * env.spread;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + a0, u = hash2(J + i, 3);
          const vy = this.rise(0.5 + u * 0.7, y, floor, env, 0, 2.5);
          sparks.spawn(P, cx, y, cz, Math.cos(a) * spread * 1.5, vy, Math.sin(a) * spread * 1.5, (s.ms / 1000) * (0.8 + 0.4 * u), 0.25 * s.size * k, 0.7 * s.size * k, u > 0.5 ? PIGMENT.fire : PIGMENT.ember, 0.9 * env.fire, -0.4, 2.5);
        }
        if (decals) rings.add(R, cx, y - 0.2, cz, 0.3 * s.size * k, 1.4 * spread, now, s.ms, PIGMENT.fire, 0.7 * env.fire, RING.wash);
        return;
      }
      case 'debris': {
        const n = this.count(s.count);
        const c = this.pigment(d, s.pigment, PIGMENT.debris);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + hash2(J + i, 4) * 0.8, u = hash2(J + i, 5);
          const speed = s.speed * k * (0.6 + 0.8 * u) * env.spread;
          const vy = s.ring ? (u - 0.5) * 0.2 * s.speed : this.rise(s.arc * (0.7 + 0.6 * u), y, floor, env, env.gravity, 0);
          debris.spawn(P, x, y, z, Math.cos(a) * speed, vy, Math.sin(a) * speed, s.life * (0.8 + 0.4 * u), s.size * k * (0.7 + 0.6 * u), s.size * k * 0.5, c, 1, env.gravity, env.drag * 0.3, floor);
        }
        return;
      }
      case 'sparks': {
        const n = this.count(s.count);
        const c = this.pigment(d, s.pigment, PIGMENT.spark);
        const len = s.size ?? 0.08;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + hash2(J + i, 6), u = hash2(J + i, 7);
          const speed = s.speed * Math.sqrt(k) * (0.5 + u) * env.spread;
          sparks.spawn(P, x, y, z, Math.cos(a) * speed, this.rise(speed * 0.6 * u, y, floor, env, env.gravity, 0), Math.sin(a) * speed, s.life, len, len * 0.25, c, 1, env.gravity * 0.8, 0, floor);
        }
        return;
      }
      case 'dust': {
        const n = this.count(s.count);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + hash2(J + i, 8), u = hash2(J + i, 9);
          const speed = s.spread * k * env.spread * (0.7 + 0.6 * u);
          smoke.spawn(P, x, floor + 0.12, z, Math.cos(a) * speed * 1.6, this.rise(0.3 + 0.3 * u, floor + 0.12, floor, env, 0, 1.6), Math.sin(a) * speed * 1.6, s.life * this.linger, 0.3 * s.size * k, s.size * k, PIGMENT.dust, 0.7, 0, 1.6);
        }
        return;
      }
      case 'rubble': {
        if (env.gravity <= 0) return;
        const n = this.count(s.count);
        const top = Number.isFinite(env.ceiling) ? floor + env.ceiling : y + s.drop * k;
        for (let i = 0; i < n; i++) {
          const ox = (hash2(J + i, 10) - 0.5) * k * env.spread, oz = (hash2(J + i, 11) - 0.5) * k * env.spread;
          debris.spawn(P, x + ox, top, z + oz, ox * 0.3, -0.5 - hash2(J + i, 12), oz * 0.3, s.life, s.size * k * (0.7 + 0.6 * hash2(J + i, 13)), s.size * k * 0.6, PIGMENT.debris, 1, env.gravity, 0, floor);
        }
        return;
      }
      case 'ring':
        if (decals) rings.add(R, x, y - 0.15, z, s.r0 * k, s.r1 * k, now, s.ms, this.pigment(d, s.pigment, PIGMENT.spark), s.alpha, RING_STYLE[s.style]);
        return;
      case 'scorch':
        if (env.scorch && decals) rings.add(R, x, floor + 0.05, z, 0.55 * s.size * k, 0.85 * s.size * k, now, s.ms * this.linger, this.pigment(d, s.pigment, PIGMENT.soot), 0.95, RING.splat);
        return;
      default:
        return;
    }
  }

  /** One frame of a lingering column at progress `t` (0..1); returns the emission debt left. */
  private column(d: DeathSlot, s: Extract<DeathStage, { kind: 'smoke' }>, stage: number, t: number, debt: number, plane: Plane, env: DeathPlaneEnv, x: number, y: number, z: number, floor: number, reveal: boolean, now: number): number {
    if (env.smoke === 'none') return 0;
    const P = PIDX[plane] + (reveal ? REVEALED : 0);
    const k = d.scale;
    const dust = env.smoke === 'dust';
    const c = dust ? PIGMENT.dust : this.pigment(d, s.pigment, PIGMENT.smoke);
    // the column thins as it dies down
    const a0 = (s.alpha ?? 0.7) * (1 - 0.5 * t);
    const drag = dust ? 1.6 : 0.6;
    for (; debt >= 1; debt--) {
      const u = hash2(d.seed * 389 + stage * 7 + debt * 17, now), w = hash2(now, d.seed * 211 + debt);
      const vy = this.rise(s.rise * Math.sqrt(k) * (0.8 + 0.4 * u), y, floor, env, 0, drag);
      this.pools.smoke.spawn(P, x + (u - 0.5) * 0.4 * k * env.spread, y + 0.15, z + (w - 0.5) * 0.4 * k * env.spread, (w - 0.5) * 0.25 + 0.12, vy, (u - 0.5) * 0.25, s.life * this.linger, 0.3 * s.size * k, s.size * k, c, a0, 0, drag);
    }
    return debt;
  }

  reset(): void {
    for (let i = 0; i < this.slots.length; i++) this.free(this.slots[i]!);
    this.openCount = 0;
    this.shake = 0;
  }
}
