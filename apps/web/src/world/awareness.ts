/**
 * Cross-plane awareness while focused on one plane: violet shadows of what flies above, pencil tremor ripples of what
 * digs below, charred ink cracks over planted charges (their stamps are in `telegraphs.ts`), energy-flow beams
 * (solar → Spire, relay → Spire), red-pencil combat heat rings and rally flags; in the Depths, Warden flares glowing
 * where they landed for their lifetime and the shield-wall barrier of every walled Warden.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  type Node,
} from 'three/webgpu';
import { abs, atan, color, float, fract, instancedDynamicBufferAttribute, mix, mx_noise_float, positionGeometry, positionLocal, sin, smoothstep, time, uv, vec3 } from 'three/tsl';
import { ECON, PLANES, PLANE_Y, TICK_RATE, sunOffset, type Plane, type View } from '@agent-command/game/contract';
import { fadeValue } from './fade.ts';
import { THREAT_COLOR, clamp, sideColor, wx, wz } from './common.ts';
import { HEAT_CELL, type Combat } from './combat.ts';
import { cel, clockAt, overlay, planeLines, type V3 } from './materials.ts';
import { INK, LINE, SHADOW } from './palette.ts';
import { TerrainField, groundAt } from './terrain.ts';
import { SPIRE_HEIGHT, spireBaseY } from './spires.ts';
import { orbitMuzzle, type Track } from './entities.ts';
import { miningSurface } from './asteroid.ts';

type V4 = Node<'vec4'>;

/** One instanced decal layer with a per-instance vec4 (rgb, alpha) and a flat/oriented transform writer. */
class Layer {
  readonly mesh: InstancedMesh;
  readonly tint: InstancedBufferAttribute;
  readonly t: V4;
  readonly cap: number;
  n = 0;
  private arr: Float32Array;
  private tints: Float32Array;

  constructor(geo: BufferGeometry, cap: number, build: (t: V4) => MeshBasicNodeMaterial) {
    this.cap = cap;
    this.tint = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.tint.setUsage(DynamicDrawUsage);
    this.t = instancedDynamicBufferAttribute<'vec4'>(this.tint, 'vec4');
    this.mesh = new InstancedMesh(geo, build(this.t), cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.arr = this.mesh.instanceMatrix.array as Float32Array;
    this.tints = this.tint.array as Float32Array;
  }

  begin(): void {
    this.n = 0;
  }

  /** Axis-aligned instance: scale (sx, sy, sz) at (x, y, z). */
  put(x: number, y: number, z: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.cap || a <= 0.003) return;
    const o = this.n * 16;
    const m = this.arr;
    m[o] = sx; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    const t = this.n * 4;
    this.tints[t] = r; this.tints[t + 1] = g; this.tints[t + 2] = b; this.tints[t + 3] = a;
    this.n++;
  }

  /** Unit-height column (geometry spans y 0..1) stretched from A to B, radius w. */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.cap || a <= 0.003) return;
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
    dx /= len; dy /= len; dz /= len;
    // basis: y = direction; x = normalize(dir × ref)
    let rx = 1, ry = 0, rz = 0;
    if (Math.abs(dx) > 0.9) {
      rx = 0; rz = 1;
    }
    let xx = dy * rz - dz * ry, xy = dz * rx - dx * rz, xz = dx * ry - dy * rx;
    const xl = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const zx = xy * dz - xz * dy, zy = xz * dx - xx * dz, zz = xx * dy - xy * dx;
    const o = this.n * 16;
    const m = this.arr;
    m[o] = xx * w; m[o + 1] = xy * w; m[o + 2] = xz * w; m[o + 3] = 0;
    m[o + 4] = dx * len; m[o + 5] = dy * len; m[o + 6] = dz * len; m[o + 7] = 0;
    m[o + 8] = zx * w; m[o + 9] = zy * w; m[o + 10] = zz * w; m[o + 11] = 0;
    m[o + 12] = ax; m[o + 13] = ay; m[o + 14] = az; m[o + 15] = 1;
    const t = this.n * 4;
    // alpha carries the beam length (integer part, tiles) + opacity (fraction) for the dash shader
    this.tints[t] = r; this.tints[t + 1] = g; this.tints[t + 2] = b; this.tints[t + 3] = Math.floor(len) + Math.min(0.999, a);
    this.n++;
  }

  /** Upright instance turned to face the planar unit direction (c, s): local X across it, local Z along it. */
  facing(x: number, y: number, z: number, c: number, s: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.cap || a <= 0.003) return;
    const o = this.n * 16;
    const m = this.arr;
    m[o] = s * sx; m[o + 1] = 0; m[o + 2] = -c * sx; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = c * sz; m[o + 9] = 0; m[o + 10] = s * sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    const t = this.n * 4;
    this.tints[t] = r; this.tints[t + 1] = g; this.tints[t + 2] = b; this.tints[t + 3] = a;
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tint.needsUpdate = true;
  }
}

const disc = () => new CircleGeometry(1, 32).rotateX(-Math.PI / 2);
const radial = () => uv().sub(0.5).length().mul(2);
/** Warm flare light; the glow pool spans this share of the flare's lit reach (rules.depths.flareRange). */
const FLARE_LIGHT = new Color('#ff7a5c');
const FLARE_POOL = 0.5;
/** A shield wall: across the Warden's cell (tiles), its height and thickness, set this far ahead of the Warden. */
const WALL = { span: 1, height: 0.8, depth: 0.1, ahead: 0.32 } as const;

export class Awareness {
  readonly root = new Group();
  private readonly shadows: Layer;
  private readonly tremors: Layer;
  private readonly cracks: Layer;
  private readonly flows: Layer;
  private readonly miningBeams: Layer;
  private readonly miningHalos: Layer;
  private readonly miningContacts: Layer;
  private readonly miningOrigin = new Float64Array(3);
  private readonly miningContact = new Float64Array(3);
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  private readonly pulses: Layer;
  private readonly flags: Layer;
  private readonly flareGlows: Layer;
  private readonly flareCores: Layer;
  private readonly walls: Layer;
  /** Every layer in draw-list order (`root.children`), for the per-frame begin/end pass. */
  private readonly layers: readonly Layer[];

  readonly size: number;
  private readonly combat: Combat;
  private readonly terrain: TerrainField;

  constructor(combat: Combat, size: number, terrain = new TerrainField(size)) {
    this.combat = combat;
    this.size = size;
    this.terrain = terrain;
    this.root.renderOrder = 35; // groupOrder: after plane layers, before entities

    // cast shadows of what flies above: the plane's violet shadow tint, never black
    this.shadows = new Layer(disc(), 160, (t) => {
      const m = overlay(new MeshBasicNodeMaterial());
      m.colorNode = color('#4a4470');
      m.opacityNode = float(1).sub(smoothstep(0.25, 1, radial())).mul(t.w).mul(0.8);
      return m;
    });

    this.tremors = new Layer(disc(), 64, (t) => {
      const r = radial();
      // wobbly pencil ripples, faintly amber (threat), running outward
      const ripple = smoothstep(0.7, 1, sin(r.add(mx_noise_float(vec3(uv().mul(6), 2)).mul(0.04)).mul(16).sub(time.mul(7))));
      return Object.assign(overlay(new MeshBasicNodeMaterial()), {
        colorNode: mix(color(INK.surface), t.xyz, 0.3),
        opacityNode: ripple.mul(float(1).sub(r)).mul(t.w).mul(0.8),
      });
    });

    this.cracks = new Layer(disc(), 32, (t) => {
      const p = uv().sub(0.5);
      const r = p.length().mul(2);
      const a = atan(p.y, p.x);
      const wobble = mx_noise_float(vec3(r.mul(5), a.mul(2), 0)).mul(0.6);
      const crack = smoothstep(0.9, 0.99, abs(sin(a.mul(5).add(wobble).add(r.mul(1.5)))));
      const core = smoothstep(0.985, 0.999, abs(sin(a.mul(5).add(wobble).add(r.mul(1.5)))));
      // t.w = urgency (0..1): charred ink cracks whose hot core pulses faster (and blooms) as detonation nears
      const pulse = sin(time.mul(t.w.mul(14).add(3))).mul(0.5).add(0.5);
      return Object.assign(overlay(new MeshBasicNodeMaterial()), {
        colorNode: mix(color(INK.surface), color('#ff8a3a').mul(1.5), core.mul(pulse).mul(t.w)),
        opacityNode: crack.mul(float(1).sub(r.mul(0.8))).mul(t.w.mul(0.5).add(0.5)).min(1),
      });
    });

    this.flows = new Layer(new CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0), 96, (t) => {
      const len = t.w.floor();
      const alpha = fract(t.w);
      // dashes stream from A (y=0) to B (y=1)
      const dash = smoothstep(0.55, 0.9, fract(positionLocal.y.mul(len).mul(0.5).sub(time.mul(1.6))));
      return Object.assign(overlay(new MeshBasicNodeMaterial()), {
        colorNode: t.xyz,
        opacityNode: dash.mul(0.85).add(0.12).mul(alpha),
      });
    });

    this.pulses = new Layer(disc(), 64, (t) => {
      const r = radial();
      const wave = fract(time.mul(0.8).sub(r.mul(0.6)));
      const ringy = smoothstep(0.75, 1, wave).mul(float(1).sub(r));
      return Object.assign(overlay(new MeshBasicNodeMaterial()), {
        colorNode: t.xyz,
        opacityNode: ringy.mul(t.w),
      });
    });

    const flagGeo = (() => {
      const pole = new CylinderGeometry(0.04, 0.04, 1.6, 5).translate(0, 0.8, 0);
      const cloth = new ConeGeometry(0.32, 0.6, 3).rotateZ(-Math.PI / 2).scale(1, 0.6, 0.15).translate(0.3, 1.4, 0);
      return mergeTwo(pole, cloth);
    })();
    this.flags = new Layer(flagGeo, 8, (t) => {
      const m = new MeshBasicNodeMaterial();
      m.colorNode = cel(t.xyz as V3, SHADOW.surface);
      m.opacityNode = t.w;
      m.alphaHash = true;
      m.mrtNode = planeLines('surface');
      return m;
    });

    // Warden flares: a flickering warm pool of light on the tunnel floor round a bright (blooming) core
    this.flareGlows = new Layer(disc(), 32, (t) => {
      const r = radial();
      const flicker = sin(time.mul(23)).mul(0.08).add(sin(time.mul(7.3)).mul(0.07)).add(0.85);
      return Object.assign(overlay(new MeshBasicNodeMaterial()), {
        colorNode: t.xyz.mul(1.6),
        opacityNode: float(1).sub(smoothstep(0, 1, r)).pow(2).mul(flicker).mul(t.w).mul(0.8),
      });
    });
    this.flareCores = new Layer(new OctahedronGeometry(0.09, 0), 32, (t) => Object.assign(overlay(new MeshBasicNodeMaterial()), {
      colorNode: t.xyz.mul(2.4),
      opacityNode: t.w,
    }));

    // Warden shield walls: a team-coloured plate across the cell, chalk-banded like riveted riot shields
    this.walls = new Layer(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 48, (t) => {
      const band = smoothstep(0.8, 0.92, fract(positionGeometry.y.add(0.5).mul(4))).max(smoothstep(0.42, 0.5, abs(positionGeometry.x)));
      return Object.assign(overlay(new MeshBasicNodeMaterial()), {
        colorNode: mix(t.xyz, color(LINE.depths), band.mul(0.7)),
        opacityNode: t.w.mul(band.mul(0.25).add(0.6)),
      });
    });

    // Sustained harvesting optics, separate from dashed energy delivery. All use the bounded instanced Layer pool.
    const miningGeometry = new CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);
    this.miningHalos = new Layer(miningGeometry, 96, (t) =>
      Object.assign(overlay(new MeshBasicNodeMaterial()), { colorNode: t.xyz, opacityNode: fract(t.w) }));
    this.miningBeams = new Layer(miningGeometry, 96, (t) =>
      Object.assign(overlay(new MeshBasicNodeMaterial()), { colorNode: t.xyz, opacityNode: fract(t.w) }));
    this.miningContacts = new Layer(new OctahedronGeometry(1), 384, (t) =>
      Object.assign(overlay(new MeshBasicNodeMaterial()), { colorNode: t.xyz, opacityNode: t.w }));
    this.miningBeams.mesh.name = 'orbit-mining-beams';
    this.miningHalos.mesh.name = 'orbit-mining-halos';
    this.miningContacts.mesh.name = 'orbit-mining-contacts';

    this.layers = [this.shadows, this.tremors, this.cracks, this.flows, this.miningHalos, this.miningBeams, this.miningContacts, this.pulses, this.flags, this.flareGlows, this.flareCores, this.walls];
    for (const l of this.layers) this.root.add(l.mesh);
  }

  frame(view: View | undefined, tracks: ReadonlyMap<string, Track>, sinceView: number, focus: Plane, sunAngle: number): void {
    for (const l of this.layers) l.begin();
    if (view) {
      const army = view.army;
      const fs = fadeValue.surface;
      const fd = fadeValue.depths;
      const sy = PLANE_Y.surface + 0.04;
      const curTick = view.tick + sinceView * TICK_RATE;

      // shadows of the sky (and falling asteroids) on the surface; islands cast their silhouette (`island-shadows.ts`)
      if (fs > 0.03) {
        for (const tr of tracks.values()) {
          const e = tr.e;
          if (e.plane !== 'sky' || e.kind === 'island') continue;
          const r = e.kind === 'bomber' || e.kind === 'gunship' ? 1 : e.kind === 'relay' ? 0.5 : 0.6;
          this.shadows.put(wx(tr.rx, this.size), sy + groundAt(tr.rx, tr.ry, this.terrain), wz(tr.ry, this.size), r, 1, r, 0, 0, 0, 0.45 * fs);
        }
        for (const imp of view.impacts) {
          const p = Math.min(1, Math.max(0, 1 - (imp.tick - curTick) / Math.max(1, imp.tick - (imp.start ?? imp.tick - ECON.impactTicks))));
          const r = 0.5 + p * (imp.radius ?? ECON.impactRadius);
          this.shadows.put(wx(imp.x, this.size), sy + groundAt(imp.x, imp.y, this.terrain), wz(imp.y, this.size), r, 1, r, 0, 0, 0, (0.25 + p * 0.45) * fs);
        }
      }

      // tremors: enemy diggers/sappers sensed under our surface presence
      if (fs > 0.03)
        for (const t of view.tremors) this.tremors.put(wx(t.x + 0.5, this.size), sy + groundAt(t.x + 0.5, t.y + 0.5, this.terrain) + 0.02, wz(t.y + 0.5, this.size), ECON.tremorRadius, 1, ECON.tremorRadius, THREAT_COLOR.r, THREAT_COLOR.g, THREAT_COLOR.b, fs);

      // planted charges: cracks on the surface (and the charge cell in the Depths)
      for (const c of view.charges) {
        const left = Math.max(0, c.tick - curTick);
        const urg = 1 - Math.min(1, left / ECON.undermineTicks);
        const rr = ECON.collapseRadius + 0.4;
        if (fs > 0.03) this.cracks.put(wx(c.x + 0.5, this.size), sy + groundAt(c.x + 0.5, c.y + 0.5, this.terrain) + 0.03, wz(c.y + 0.5, this.size), rr, 1, rr, 0, 0, 0, urg);
        if (fd > 0.03) this.cracks.put(wx(c.x + 0.5, this.size), PLANE_Y.depths + 0.06, wz(c.y + 0.5, this.size), 0.8, 1, 0.8, 0, 0, 0, urg);
      }

      // energy chain (own army): solar arrays → Spire orbit segment; relays → Spire sky segment
      let sp = view.match!.armies[0]!.spireAt;
      for (const a of view.match!.armies) if (a.id === army) sp = a.spireAt;
      const scx = wx(sp.x, this.size);
      const scz = wz(sp.y, this.size);
      const tc = sideColor(army);
      const sun = view.match!.sun;
      // Current fog-filtered endpoints only; fading tracks never sustain mining effects.
      const now = performance.now(), miningClock = clockAt(now);
      if (fadeValue.orbit > 0.03) for (const e of view.entities) {
        if (e.kind !== 'tug' || e.state !== 'mining' || !e.miningTarget) continue;
        const tr = tracks.get(e.id), rock = tracks.get(e.miningTarget);
        if (!tr || !rock || rock.e.kind !== 'asteroid') continue;
        let visible = false;
        for (const seen of view.entities) if (seen.id === e.miningTarget) { visible = true; break; }
        if (!visible) continue;
        if (!orbitMuzzle(this.miningOrigin, tr, 0, now, this.size) || !miningSurface(this.miningContact, this.miningOrigin, rock, now, this.size)) continue;
        const x = this.miningOrigin[0]!, y = this.miningOrigin[1]!, z = this.miningOrigin[2]!;
        const tx = this.miningContact[0]!, ty = this.miningContact[1]!, tz = this.miningContact[2]!;
        const ice = rock.e.resourceType === 'ice', r = ice ? 0.55 : 1, g = ice ? 0.9 : 0.72, b = ice ? 1 : 0.35;
        this.miningHalos.beam(x, y, z, tx, ty, tz, 0.07, r, g, b, 0.2 * fadeValue.orbit);
        this.miningBeams.beam(x, y, z, tx, ty, tz, 0.025, 0.9 + r * 0.1, 0.9 + g * 0.1, 0.8 + b * 0.2, 0.95 * fadeValue.orbit);
        this.miningContacts.put(tx, ty, tz, 0.085, 0.085, 0.085, 1, 0.95, 0.8 + b * 0.2, 0.95 * fadeValue.orbit);
        // Three short surface flecks, not a particle simulation; reduced motion keeps just the steady beam/contact.
        if (!this.motion?.matches) {
          const length = Math.hypot(x - tx, y - ty, z - tz);
          for (let i = 0; i < 3; i++) {
            const age = (miningClock * 1.7 + tr.phase + i / 3) % 1;
            const distance = age * 0.25, radius = (1 - age) * 0.025;
            this.miningContacts.put(tx + (x - tx) / length * distance, ty + (y - ty) / length * distance + Math.sin(age * Math.PI) * 0.1,
              tz + (z - tz) / length * distance + Math.sin(i * 2.1) * age * 0.08,
              radius, radius, radius, r, g, b, (1 - age) * 0.65 * fadeValue.orbit);
          }
        }
      }
      for (const tr of tracks.values()) {
        const e = tr.e;
        if (e.side !== army) continue;
        if (e.kind === 'solar' && fadeValue.orbit > 0.03) {
          const lit = Math.abs(sunOffset(e.x, e.y, sunAngle, this.size, sun.wedges)) < sun.half;
          this.flows.beam(wx(tr.rx, this.size), tr.wy, wz(tr.ry, this.size), scx, spireBaseY('orbit', sp.x, sp.y, this.terrain) + SPIRE_HEIGHT.orbit, scz, 0.05, 1, 0.82, 0.35, (lit ? 0.9 : 0.15) * fadeValue.orbit);
        } else if (e.kind === 'relay' && e.state !== 'constructing' && fadeValue.sky > 0.03) {
          this.flows.beam(wx(tr.rx, this.size), tr.wy + 1.75, wz(tr.ry, this.size), scx, spireBaseY('sky', sp.x, sp.y, this.terrain) + SPIRE_HEIGHT.sky, scz, 0.05, tc.r, tc.g, tc.b, 0.8 * fadeValue.sky);
        }
      }

      // combat heat: where the fights are
      for (const p of PLANES) {
        const f = fadeValue[p];
        if (f < 0.03) continue;
        const h = this.combat.heat[p];
        const y = PLANE_Y[p] + (p === 'sky' ? 0.9 : p === 'depths' ? 0.08 : 0.06);
        for (let i = 0; i < h.length; i++) {
          const v = h[i]!;
          if (v < 0.6) continue;
          const cx = wx(((i % this.combat.heatN) + 0.5) * HEAT_CELL, this.size);
          const cz = wz((Math.floor(i / this.combat.heatN) + 0.5) * HEAT_CELL, this.size);
          const r = HEAT_CELL * (0.8 + Math.min(1, v / 3) * 0.6);
          this.pulses.put(cx, y, cz, r, 1, r, 0.75, 0.31, 0.35, Math.min(1, v / 3) * 0.55 * (p === focus ? 1 : 0.5) * f);
        }
      }

      // rally flags
      for (const r of view.rally) {
        const f = fadeValue[r.plane];
        if (f < 0.03) continue;
        this.flags.put(wx(r.x, this.size), PLANE_Y[r.plane] + (r.plane === 'sky' ? 1 : 0.05), wz(r.y, this.size), 1, 1, 1, tc.r, tc.g, tc.b, f);
      }

      if (fd > 0.03) {
        // flares: lit until their last tick, fading over the final second
        const pool = view.match!.rules.depths.flareRange * FLARE_POOL;
        for (const f of view.flares) {
          const a = clamp((f.until - curTick) / TICK_RATE, 0, 1) * fd;
          const x = wx(f.x + 0.5, this.size), z = wz(f.y + 0.5, this.size);
          this.flareGlows.put(x, PLANE_Y.depths + 0.07, z, pool, 1, pool, FLARE_LIGHT.r, FLARE_LIGHT.g, FLARE_LIGHT.b, a);
          this.flareCores.put(x, PLANE_Y.depths + 0.16, z, 1, 1, 1, FLARE_LIGHT.r, FLARE_LIGHT.g, FLARE_LIGHT.b, a);
        }
        // shield walls ahead of every seen Warden raising, holding or lowering one (half height while it moves)
        for (const tr of tracks.values()) {
          const e = tr.e;
          if (e.kind !== 'warden' || e.plane !== 'depths' || !tr.visible) continue;
          if (e.state !== 'walling' && e.state !== 'walled' && e.state !== 'unwalling') continue;
          const c = Math.cos(tr.heading), s = Math.sin(tr.heading);
          const k = e.state === 'walled' ? 1 : 0.5;
          const col = sideColor(e.side);
          this.walls.facing(wx(tr.rx + c * WALL.ahead, this.size), PLANE_Y.depths, wz(tr.ry + s * WALL.ahead, this.size), c, s, WALL.span, WALL.height * k, WALL.depth, col.r, col.g, col.b, (0.35 + 0.5 * k) * fd);
        }
      }
    }
    for (const l of this.layers) l.end();
  }
}


function mergeTwo(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  const A = a.index ? a.toNonIndexed() : a;
  const B = b.index ? b.toNonIndexed() : b;
  const out = new BufferGeometry();
  for (const name of ['position', 'normal'] as const) {
    const x = A.getAttribute(name).array as Float32Array;
    const y = B.getAttribute(name).array as Float32Array;
    const z = new Float32Array(x.length + y.length);
    z.set(x);
    z.set(y, x.length);
    out.setAttribute(name, new BufferAttribute(z, 3));
  }
  return out;
}

