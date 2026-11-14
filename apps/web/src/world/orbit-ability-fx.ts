import { Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, Object3D, PlaneGeometry, RingGeometry, SphereGeometry, type BufferGeometry } from 'three/webgpu';
import { float, instancedDynamicBufferAttribute, sin, smoothstep, time, uv } from 'three/tsl';
import { PLANE_Y, TICK_RATE, UNIT_KINDS, type Entity, type View } from '@agent-command/game/contract';
import { THREAT_COLOR, clamp, sideColor, wx, wz } from './common.ts';
import { fadeValue } from './fade.ts';
import { overlay, seen } from './materials.ts';
import type { Track } from './entities.ts';
import type { FogField } from './fog.ts';
import { orbitAbilityReady } from '../tools/orbit-abilities.ts';

const CAP = 256;
const SHIPS = 1024;
const EMPTY: readonly Entity[] = [];
const GOLD = new Color('#ffe6a0');
const ICE = new Color('#bce9ff');
const IS_SHIP = new Set<string>(UNIT_KINDS);

/** One preallocated draw stream; transforms and tint storage are reused for every frame. */
class Stream {
  readonly mesh: InstancedMesh;
  private readonly tint: InstancedBufferAttribute;
  private readonly pose = new Object3D();
  n = 0;
  constructor(geometry: BufferGeometry, cap: number, shimmer = false, fogField?: FogField) {
    this.tint = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    const t = instancedDynamicBufferAttribute<'vec4'>(this.tint, 'vec4');
    const material = overlay(new MeshBasicNodeMaterial());
    material.colorNode = t.xyz;
    const wave = sin(uv().y.mul(70).add(time.mul(shimmer ? 7 : 3))).mul(0.5).add(0.5);
    material.opacityNode = t.w.mul(shimmer ? smoothstep(0.65, 0.95, wave).mul(0.7).add(0.08) : float(1)).mul(seen('orbit', fogField));
    this.mesh = new InstancedMesh(geometry, material, cap);
    this.mesh.name = shimmer ? 'orbit-cloak-shimmer' : 'orbit-ability-stream';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }
  put(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, color: Color, alpha: number): void {
    if (this.n >= this.mesh.instanceMatrix.count || alpha <= 0) return;
    const p = this.pose;
    p.position.set(x, y, z); p.rotation.set(0, yaw, 0); p.scale.set(sx, sy, sz); p.updateMatrix();
    this.mesh.setMatrixAt(this.n, p.matrix);
    this.tint.setXYZW(this.n++, color.r, color.g, color.b, alpha);
  }
  flush(): void {
    this.mesh.count = this.n;
    if (this.n) { this.mesh.instanceMatrix.needsUpdate = true; this.tint.needsUpdate = true; }
  }
}

/** Fogged snapshots only. No remembered enemies, hidden hulls, or per-frame object/geometry creation. */
export class OrbitAbilityFx {
  readonly root = new Group();
  private readonly lines: Stream;
  private readonly rings: Stream;
  private readonly shimmers: Stream;
  private view: View | undefined;
  private tickMs = 0;
  private msPerTick = 1000 / TICK_RATE;
  private aimX = NaN;
  private aimY = NaN;
  private aiming: readonly Entity[] = EMPTY;

  readonly size: number;

  constructor(size: number, fogField?: FogField) {
    this.size = size;
    this.lines = new Stream(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), CAP * 3, false, fogField);
    this.rings = new Stream(new RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2), SHIPS, false, fogField);
    this.shimmers = new Stream(new SphereGeometry(1, 16, 10), SHIPS, true, fogField);
    this.root.name = 'orbit-abilities';
    this.root.renderOrder = 46;
    this.lines.mesh.name = 'orbit-ability-lines';
    this.rings.mesh.name = 'orbit-ability-rings';
    this.root.add(this.lines.mesh, this.rings.mesh, this.shimmers.mesh);
  }

  aim(x = NaN, y = NaN, units: readonly Entity[] = EMPTY): void {
    this.aimX = x; this.aimY = y; this.aiming = units;
  }

  reset(): void {
    this.view = undefined; this.aim();
    this.lines.mesh.count = this.rings.mesh.count = this.shimmers.mesh.count = 0;
  }

  ingest(view: View, at: (tick: number) => number): void {
    this.view = view;
    this.tickMs = at(view.tick);
    this.msPerTick = Math.max(1, at(view.tick + 1) - this.tickMs);
  }

  private line(x: number, y: number, tx: number, ty: number, height: number, width: number, color: Color, alpha: number): void {
    const dx = tx - x, dz = ty - y;
    this.lines.put(wx((x + tx) / 2, this.size), height, wz((y + ty) / 2, this.size), Math.hypot(dx, dz), 1, width, -Math.atan2(dz, dx), color, alpha);
  }

  update(now: number, tracks: ReadonlyMap<string, Track>, camY: number): void {
    this.lines.n = this.rings.n = this.shimmers.n = 0;
    const view = this.view;
    const alpha = fadeValue.orbit * clamp((camY - PLANE_Y.orbit - 2) / 6, 0, 1);
    if (!view?.match || alpha <= 0.01) {
      this.lines.flush(); this.rings.flush(); this.shimmers.flush();
      return;
    }
    const rules = view.match.rules.orbit;
    const tick = view.tick + (now - this.tickMs) / this.msPerTick;
    for (const tr of tracks.values()) {
      const e = tr.e;
      if (!tr.visible || e.plane !== 'orbit' || e.hp <= 0) continue;
      if (e.lance && tick < e.lance.at) {
        const dx = e.lance.x - tr.rx, dy = e.lance.y - tr.ry, d = Math.hypot(dx, dy);
        if (d > 0.001) {
          const progress = clamp(1 - (e.lance.at - tick) / (rules.lanceCharge * TICK_RATE), 0, 1);
          const color = e.side === view.army ? GOLD : THREAT_COLOR;
          this.line(tr.rx, tr.ry, tr.rx + dx / d * rules.lanceRange, tr.ry + dy / d * rules.lanceRange, tr.wy + 0.24, 0.025 + 0.055 * progress, color, alpha * (0.35 + progress * 0.6));
          this.rings.put(wx(tr.rx, this.size), tr.wy + 0.18, wz(tr.ry, this.size), 0.3 + progress * 0.5, 1, 0.3 + progress * 0.5, 0, color, alpha * 0.8);
        }
      }
      if (e.aegis && tick < e.aegis.until && e.aegis.pool > 0) {
        const c = sideColor(e.side);
        this.rings.put(wx(tr.rx, this.size), tr.wy + 0.08, wz(tr.ry, this.size), rules.aegisRadius, 1, rules.aegisRadius, 0, c, alpha * 0.7);
        // Coverage is geometric, not inferred damage state, and only observed allies get a marker.
        for (const ally of tracks.values()) {
          if (!ally.visible || ally.e.hp <= 0 || ally.e.plane !== 'orbit' || ally.e.side !== e.side || !IS_SHIP.has(ally.e.kind)) continue;
          if (Math.hypot(ally.rx - tr.rx, ally.ry - tr.ry) <= rules.aegisRadius)
            this.rings.put(wx(ally.rx, this.size), ally.wy + 0.1, wz(ally.ry, this.size), 0.52, 1, 0.52, 0, c, alpha * 0.5);
        }
      }
      if (e.cloaked) this.shimmers.put(wx(tr.rx, this.size), tr.wy + 0.18, wz(tr.ry, this.size), 0.5, 0.22, 0.3, -tr.heading, ICE, alpha * (0.12 + clamp(tr.speed / 3, 0, 1) * 0.35));
    }
    if (Number.isFinite(this.aimX)) for (const e of this.aiming) {
      if (!orbitAbilityReady(e, 'sun_lance', view)) continue;
      const tr = tracks.get(e.id);
      if (!tr?.visible) continue;
      const dx = this.aimX - tr.rx, dy = this.aimY - tr.ry, d = Math.hypot(dx, dy);
      if (d > 0.001) this.line(tr.rx, tr.ry, tr.rx + dx / d * rules.lanceRange, tr.ry + dy / d * rules.lanceRange, tr.wy + 0.23, 0.035, GOLD, alpha * 0.4);
    }
    this.lines.flush(); this.rings.flush(); this.shimmers.flush();
  }
}
