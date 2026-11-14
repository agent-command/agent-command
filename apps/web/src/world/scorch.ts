/**
 * Burning ground left by volatile impacts (`view.scorches`: x, y, radius, until; Surface only, fog-filtered by the
 * server like every hazard):
 *
 * - **Mark** (`ScorchMarks`): a charred, ground-following wash over the zone (`drape.ts`, so it lines the crater) with
 *   ember cracks: thin orange-red ink lines on the edges of a cellular pattern, pulsing. One instanced draw.
 * - **Fire** (`ScorchFire`): licking flame tongues, rising embers and a smoke column, spawned into the shared particle
 *   pools (`gpu-particles.ts`) at a steady rate per tile of burning area.
 *
 * Both die down over the zone's last `COOL_S` seconds and are gone at `until`; a zone first seen part-way through burns
 * at the strength its remaining time implies. Nothing here allocates per frame.
 */
import { Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { float, instancedDynamicBufferAttribute, max, mix, mx_noise_float, mx_noise_vec3, mx_worley_noise_vec2, positionWorld, sin, smoothstep, uv, vec2 } from 'three/tsl';
import { PLANE_Y, TICK_RATE, type View } from '@agent-command/game/contract';
import { hash2, wx, wz } from './common.ts';
import { Drape } from './drape.ts';
import { FADE, fadeValue } from './fade.ts';
import type { FogField } from './fog.ts';
import type { ParticlePool } from './gpu-particles.ts';
import { clock, overlay, rgb, seen, type F1, type V3 } from './materials.ts';
import { TerrainField, groundAt } from './terrain.ts';

/** Zones drawn at once (a view lists only the visible ones; any beyond this burn without a mark or fire). */
export const SCORCH_ZONES = 32;
/** Final seconds over which a zone's fire and cracks die down to nothing. */
export const COOL_S = 4;
/** The mark's quad half extent per zone radius: the soot feathers out just past the burning edge. */
const EXTENT = 1.12;

/** Emission per second at full heat per unit of burning area (a radius-3 zone = 1 unit). */
const RATE = { flame: 14, ember: 5, smoke: 2 } as const;

const FLAME = new Color('#ec5a24');
const FLAME_HOT = new Color('#ffb347');
const FLAME_CORE = new Color('#fff0b0');
const EMBER = new Color('#ff7a2a');
const EMBER_HOT = new Color('#ffd27a');
const SMOKE = new Color('#3d3735');

/** How hot a zone burns `left` seconds before it cools, first seen with `total` seconds left (0..1). */
export function scorchHeat(left: number, total: number): number {
  if (left <= 0) return 0;
  const k = Math.min(1, left / COOL_S);
  return k * k * (3 - 2 * k) * (0.55 + 0.45 * Math.min(1, left / Math.max(total, 1e-3)));
}

/** Flames, embers and smoke over every visible burning zone, spawned into the shared pools. */
export class ScorchFire {
  private readonly size: number;
  private readonly terrain: TerrainField;
  /** Tracked zones by slot: position, expiry tick, seconds left when first seen, emission debt, spawn sequence. */
  private readonly zx = new Float64Array(SCORCH_ZONES);
  private readonly zy = new Float64Array(SCORCH_ZONES);
  private readonly zuntil = new Float64Array(SCORCH_ZONES);
  private readonly ztotal = new Float64Array(SCORCH_ZONES);
  private readonly debt = new Float64Array(SCORCH_ZONES * 3);
  private readonly seq = new Uint32Array(SCORCH_ZONES);
  private readonly seenAt = new Uint32Array(SCORCH_ZONES);
  private readonly used = new Uint8Array(SCORCH_ZONES);
  private frameNo = 0;

  constructor(size: number, terrain = new TerrainField(size)) {
    this.size = size;
    this.terrain = terrain;
  }

  frame(scorches: NonNullable<View['scorches']>, renderTick: number, dt: number, sparks: ParticlePool, smoke: ParticlePool): void {
    const frame = ++this.frameNo;
    // Nothing to draw while the Surface is hidden (other planes keep their own effects); zones keep their slots.
    const shown = fadeValue.surface > 0.02 && dt > 0;
    for (const s of scorches) {
      const left = (s.until - renderTick) / TICK_RATE;
      if (left <= 0) continue;
      const i = this.slot(s.x, s.y, s.until, left, frame);
      if (i < 0 || !shown) continue;
      const heat = scorchHeat(left, this.ztotal[i]!);
      const area = Math.max(0.25, (s.radius / 3) ** 2);
      const o = i * 3;
      this.debt[o] = this.debt[o]! + RATE.flame * area * heat * dt;
      this.debt[o + 1] = this.debt[o + 1]! + RATE.ember * area * heat * dt;
      this.debt[o + 2] = this.debt[o + 2]! + RATE.smoke * area * heat * dt;
      for (; this.debt[o]! >= 1; this.debt[o] = this.debt[o]! - 1) this.flame(i, s.radius, sparks);
      for (; this.debt[o + 1]! >= 1; this.debt[o + 1] = this.debt[o + 1]! - 1) this.ember(i, s.radius, sparks);
      for (; this.debt[o + 2]! >= 1; this.debt[o + 2] = this.debt[o + 2]! - 1) this.smoke(i, s.radius, smoke);
    }
    // zones gone from the view (expired or out of sight) free their slots
    for (let i = 0; i < SCORCH_ZONES; i++) if (this.used[i] && this.seenAt[i] !== frame) this.used[i] = 0;
  }

  reset(): void {
    this.used.fill(0);
  }

  /** The slot tracking zone (x, y, until), claiming a free one for a new zone; −1 when all are taken. */
  private slot(x: number, y: number, until: number, left: number, frame: number): number {
    let free = -1;
    for (let i = 0; i < SCORCH_ZONES; i++) {
      if (!this.used[i]) {
        if (free < 0) free = i;
        continue;
      }
      if (this.zx[i] === x && this.zy[i] === y && this.zuntil[i] === until) {
        this.seenAt[i] = frame;
        return i;
      }
    }
    if (free < 0) return -1;
    this.used[free] = 1;
    this.seenAt[free] = frame;
    this.zx[free] = x;
    this.zy[free] = y;
    this.zuntil[free] = until;
    this.ztotal[free] = left;
    this.seq[free] = 0;
    this.debt[free * 3] = this.debt[free * 3 + 1] = this.debt[free * 3 + 2] = 0;
    return free;
  }

  /**
   * The next point of zone `i`'s deterministic sequence, within `spread` of its radius (√ for an even spread over the
   * area, skewed inward by `centre` > 0.5): writes tile x/y and ground height into `AT`, returns two spare hashes.
   */
  private point(i: number, radius: number, spread: number, centre: number): number {
    const k = this.seq[i]!++;
    const seed = Math.round(this.zx[i]! * 16) * 31 + Math.round(this.zy[i]! * 16) * 17 + this.zuntil[i]!;
    const a = hash2(k, seed) * Math.PI * 2;
    const r = Math.pow(hash2(seed, k), centre) * radius * spread;
    const x = this.zx[i]! + Math.cos(a) * r;
    const y = this.zy[i]! + Math.sin(a) * r;
    AT.x = wx(x, this.size);
    AT.z = wz(y, this.size);
    AT.y = PLANE_Y.surface + groundAt(x, y, this.terrain);
    return hash2(k * 7 + 3, seed);
  }

  /** A flame tongue: a bright lick that leaps up, narrows and dies, around a paler hot core. */
  private flame(i: number, radius: number, sparks: ParticlePool): void {
    const h = this.point(i, radius, 0.8, 0.9);
    const g = hash2(h * 97, i);
    const vx = (h - 0.5) * 0.3, vy = 1 + g * 0.8, vz = (g - 0.5) * 0.3, life = 0.45 + h * 0.35, size = 0.22 + g * 0.16;
    sparks.spawn(1, AT.x, AT.y + 0.05, AT.z, vx, vy, vz, life, size, 0.03, h > 0.5 ? FLAME_HOT : FLAME, 0.95, -0.8, 1.8);
    sparks.spawn(1, AT.x, AT.y + 0.08, AT.z, vx, vy * 1.1, vz, life * 0.7, size * 0.55, 0.02, FLAME_CORE, 1, -0.8, 1.8);
  }

  /** An ember: a tiny spark drifting up and away. */
  private ember(i: number, radius: number, sparks: ParticlePool): void {
    const h = this.point(i, radius, 0.9, 0.5);
    const g = hash2(h * 59, i + 11);
    sparks.spawn(1, AT.x, AT.y + 0.15, AT.z, (h - 0.5) * 0.7, 0.6 + g * 0.8, (g - 0.5) * 0.7, 1.4 + h * 0.8, 0.045, 0.012, g > 0.5 ? EMBER_HOT : EMBER, 1, -0.25, 0.5);
  }

  /** A puff of dark smoke rising from the hottest middle and spreading. */
  private smoke(i: number, radius: number, smoke: ParticlePool): void {
    const h = this.point(i, radius, 0.6, 1);
    const g = hash2(h * 31, i + 5);
    smoke.spawn(1, AT.x, AT.y + 0.3, AT.z, (h - 0.5) * 0.3, 0.55 + g * 0.3, (g - 0.5) * 0.3, 2.6, 0.3, 1, SMOKE, 0.55, -0.05, 0.6);
  }
}

/** Scratch spawn point (world x, ground y, world z). */
const AT = { x: 0, y: 0, z: 0 };

/** The charred, cracked ground under every visible burning zone: one draped, instanced decal. */
export class ScorchMarks {
  readonly mesh: InstancedMesh;
  private readonly size: number;
  private readonly terrain: TerrainField;
  private readonly drape = new Drape(SCORCH_ZONES, 0.05);
  /** Per instance: height row v, radius (tiles), expiry (client clock seconds), seed. */
  private readonly inst: InstancedBufferAttribute;

  constructor(size: number, terrain = new TerrainField(size), fogField?: FogField) {
    this.size = size;
    this.terrain = terrain;
    this.inst = new InstancedBufferAttribute(new Float32Array(SCORCH_ZONES * 4), 4);
    this.inst.setUsage(DynamicDrawUsage);
    this.mesh = new InstancedMesh(this.drape.geometry, this.material(fogField), SCORCH_ZONES);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Surface group: after the water sheet (2) and island shadows (7), with the ore rings.
    this.mesh.renderOrder = 8;
  }

  private material(fogField: FogField | undefined): MeshBasicNodeMaterial {
    const t = instancedDynamicBufferAttribute<'vec4'>(this.inst, 'vec4');
    const m = overlay(new MeshBasicNodeMaterial());
    m.positionNode = this.drape.position(t.x as F1);
    // PlaneGeometry rotated flat: u runs along +x, v along −z; d in tiles from the zone centre.
    const q = uv().mul(2).sub(1);
    const r = t.y;
    const d = vec2(q.x, q.y.negate()).length().mul(r.mul(EXTENT));
    const left = t.z.sub(clock);
    const heat = smoothstep(0, COOL_S, left);
    // soot: a ragged watercolour edge just past the burning radius, easing away before expiry
    const grain = mx_noise_float(positionWorld.mul(1.7)).mul(0.12).mul(r);
    const soot = float(1).sub(smoothstep(r.mul(0.55), r.mul(1.02), d.add(grain))).mul(smoothstep(0, 6, left));
    // ember cracks: the edges of a warped cellular pattern fixed in world space, broken into fissures by a coarser
    // noise, densest toward the middle, pulsing
    const warp = mx_noise_vec3(positionWorld.mul(0.7)).xz.mul(0.45);
    const cells = mx_worley_noise_vec2(positionWorld.xz.add(warp).mul(1.35).add(t.w.mul(13.7)));
    const broken = smoothstep(-0.25, 0.3, mx_noise_float(positionWorld.mul(0.85).add(t.w.mul(5.1))));
    const crack = float(1).sub(smoothstep(0.015, 0.07, cells.y.sub(cells.x))).mul(broken);
    const inner = float(1).sub(smoothstep(r.mul(0.2), r.mul(0.85), d));
    const pulse = sin(clock.mul(3.4).add(t.w.mul(6.28)).add(cells.x.mul(11))).mul(0.4).add(0.6);
    const glow = crack.mul(inner).mul(heat).mul(pulse) as F1;
    const ember = mix(rgb('#b8321c'), rgb('#ffb04a'), pulse.mul(heat)).mul(1.35) as V3;
    m.colorNode = mix(rgb('#2b1d16'), ember, glow.mul(1.4).clamp(0, 1));
    m.opacityNode = max(soot.mul(0.7), glow).mul(FADE.surface.alpha).mul(seen('surface', fogField));
    return m;
  }

  /** The current zones (fog-filtered by the server); `at(tick)` maps ticks to client clock seconds. */
  update(view: View, at: (tick: number) => number): void {
    const mat = this.mesh.instanceMatrix.array as Float32Array;
    const inst = this.inst.array as Float32Array;
    let n = 0;
    if (view.scorches) for (const s of view.scorches) {
      if (s.until <= view.tick || n >= SCORCH_ZONES) continue;
      const extent = s.radius * EXTENT;
      const o = n * 16;
      mat[o] = extent; mat[o + 1] = 0; mat[o + 2] = 0; mat[o + 3] = 0;
      mat[o + 4] = 0; mat[o + 5] = 1; mat[o + 6] = 0; mat[o + 7] = 0;
      mat[o + 8] = 0; mat[o + 9] = 0; mat[o + 10] = extent; mat[o + 11] = 0;
      mat[o + 12] = wx(s.x, this.size); mat[o + 13] = PLANE_Y.surface; mat[o + 14] = wz(s.y, this.size); mat[o + 15] = 1;
      inst[n * 4] = this.drape.rowV(n);
      inst[n * 4 + 1] = s.radius;
      inst[n * 4 + 2] = at(s.until);
      inst[n * 4 + 3] = hash2(s.x * 16, s.y * 16);
      this.drape.write(n, s.x, s.y, extent, this.terrain);
      n++;
    }
    this.mesh.count = n;
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.inst.needsUpdate = true;
    }
  }

  reset(): void {
    this.mesh.count = 0;
  }
}
