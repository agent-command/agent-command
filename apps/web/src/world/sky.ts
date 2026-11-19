/**
 * The Sky page: an opaque, outlined cel cloud deck drifting below the islands (Sable look: no transparency sorting),
 * the public weather (`weather.ts`) and the islands' drift rings, the Sky's only lines: each island's full circle in
 * its owner's ink (own / enemy / neutral), a short solid lead showing which way it travels, and for hovered or
 * selected islands a bolder ring with the dashed preview of its next minute. Islands themselves are entities
 * (`models.ts` island); a mottled cloud-sea veil covers what the team can't see.
 */
import { BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, Object3D, PlaneGeometry, type Vector3 } from 'three/webgpu';
import { abs, color, float, instancedDynamicBufferAttribute, mix, positionGeometry, positionLocal, smoothstep, uv, vec3 } from 'three/tsl';
import { PLANE_Y, TICK_RATE, islandAt, type Side, type View } from '@agent-command/game/contract';
import { FADE, fadeValue } from './fade.ts';
import { hash2, sideColor, wx, wz } from './common.ts';
import { inkMaterial, overlay, veil, type V3 } from './materials.ts';
import type { FogField } from './fog.ts';
import { cloudShapes } from './models.ts';
import { PENCIL } from './palette.ts';
import { PATH_AHEAD_S } from './plan.ts';
import { WeatherLayer } from './weather.ts';
import type { Track } from './entities.ts';
import type { DeathPlayer } from './death-fx.ts';

const tmp = new Object3D();
/** Scratch island positions (path ribbons are rebuilt every frame without allocating). */
const PT = { x: 0, y: 0 };

/** Islands drawn (rings and paths). */
const ISLAND_CAP = 16;
/** Arc segments per previewed island path, plus 4 time ticks (15 s apart). */
const ARC_SEGS = 48;
const ARC_TICKS = 4;
const ARC_CAP = ISLAND_CAP * (ARC_SEGS + ARC_TICKS);
/** Lead arc ahead of every island while the Sky is focused: its next LEAD_S seconds in LEAD_SEGS solid segments. */
const LEAD_S = 12;
const LEAD_SEGS = 10;
/** Ring widths (tiles): idle, and hovered / selected. */
const RING_W = 0.1;
const RING_HI_W = 0.22;
const NEUTRAL_INK = new Color(PENCIL.sky);

/** Cloud deck: copies of each puff shape (one instanced draw per shape). */
const CLOUDS_PER_SHAPE = 6;

/** Unit circle strip (uv.y 0 inner / 1 outer) widened in the vertex shader, so ring width is constant in tiles. */
function ringGeometry(segs = 160): BufferGeometry {
  const pos = new Float32Array((segs + 1) * 6), uvs = new Float32Array((segs + 1) * 4);
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pos.set([Math.cos(a), 0, Math.sin(a), Math.cos(a), 0, Math.sin(a)], i * 6);
    uvs.set([i / segs, 0, i / segs, 1], i * 4);
    if (i < segs) idx.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

export class SkyLayer {
  readonly group = new Group();
  /** The Sky's chart marks (drift rings, paths, fog veil), drawn over the cloud deck and weather. */
  private readonly marks = new Group();
  private readonly clouds: InstancedMesh[] = [];
  /** Per cloud: orbit radius / angle / angular speed around the map centre, height under the plane, size. */
  private readonly cloudData: { r: number; a: number; s: number; h: number; sx: number }[] = [];
  /** Drift rings: per island (world centre x, z, radius, width) and tint (rgb, alpha). */
  private readonly rings: InstancedMesh;
  private readonly ringData: InstancedBufferAttribute;
  private readonly ringTint: InstancedBufferAttribute;
  private readonly arcs: InstancedMesh;
  private readonly arcTint: InstancedBufferAttribute;
  readonly weather: WeatherLayer;
  readonly size: number;
  private readonly fogField?: FogField;

  constructor(size: number, fogField?: FogField) {
    this.fogField = fogField;
    this.size = size;
    this.weather = new WeatherLayer(size);
    const f = FADE.sky;
    // white tops, a cool grey belly; the cel ramp adds the shadow side
    const cloudMat = inkMaterial('sky', mix(color('#dde4f0'), color('#ffffff'), positionLocal.y.mul(2.2).add(0.35).clamp(0, 1)) as V3,
      { soft: 0.35, fogField, alpha: this.weather.cloudClearance });
    // Same continuous coverage as the storm: hashed deck fragments must not reintroduce a stippled cutaway rim.
    cloudMat.alphaHash = false;
    cloudMat.alphaToCoverage = true;
    for (const shape of cloudShapes()) {
      const m = new InstancedMesh(shape, cloudMat, CLOUDS_PER_SHAPE);
      m.frustumCulled = false;
      this.clouds.push(m);
      this.group.add(m);
    }
    for (let i = 0; i < this.clouds.length * CLOUDS_PER_SHAPE; i++) {
      this.cloudData.push({
        r: 3 + hash2(i, 1) * (size * Math.SQRT1_2 - 6),
        a: hash2(i, 2) * Math.PI * 2,
        s: 0.008 + hash2(i, 3) * 0.014,
        h: -6 + hash2(i, 4) * 3.2,
        sx: 1.3 + hash2(i, 5) * 1.5,
      });
    }

    this.ringData = new InstancedBufferAttribute(new Float32Array(ISLAND_CAP * 4), 4).setUsage(DynamicDrawUsage);
    this.ringTint = new InstancedBufferAttribute(new Float32Array(ISLAND_CAP * 4), 4).setUsage(DynamicDrawUsage);
    const rd = instancedDynamicBufferAttribute<'vec4'>(this.ringData, 'vec4');
    const rt = instancedDynamicBufferAttribute<'vec4'>(this.ringTint, 'vec4');
    const ringMat = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    const e = uv().y.sub(0.5);
    const r = rd.z.add(e.mul(rd.w));
    ringMat.positionNode = vec3(rd.x.add(positionGeometry.x.mul(r)), PLANE_Y.sky + 0.4, rd.y.add(positionGeometry.z.mul(r)));
    ringMat.colorNode = rt.xyz;
    // soft inked edge, drawn over the veil: island drift paths are public
    ringMat.opacityNode = rt.w.mul(float(1).sub(smoothstep(0.3, 0.5, abs(e))).mul(0.5).add(0.5)).mul(f.alpha);
    this.rings = new InstancedMesh(ringGeometry(), ringMat, ISLAND_CAP);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 6;
    this.marks.add(this.rings);

    // path previews: a solid lead per island, the dashed next minute (ticks every 15 s) when highlighted
    this.arcTint = new InstancedBufferAttribute(new Float32Array(ARC_CAP * 4), 4);
    this.arcTint.setUsage(DynamicDrawUsage);
    const at = instancedDynamicBufferAttribute<'vec4'>(this.arcTint, 'vec4');
    const am = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    am.colorNode = at.xyz.mul(0.8);
    am.opacityNode = at.w.mul(f.alpha);
    this.arcs = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), am, ARC_CAP);
    this.arcs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.arcs.count = 0;
    this.arcs.frustumCulled = false;
    this.arcs.renderOrder = 6;
    this.marks.add(this.arcs);
    this.group.add(this.weather.group);
    this.marks.add(veil('sky', PLANE_Y.sky + 0.15, size, fogField));
    this.group.add(this.marks);
  }

  update(view: View): void {
    if (view.match) this.weather.update(view.weather, view.match);
  }

  /** One flat ribbon segment from (ax, az) to (bx, bz) (world x/z), `w` wide, at height y. */
  private seg(i: number, ax: number, az: number, bx: number, bz: number, y: number, w: number, c: Color, a: number): void {
    const m = this.arcs.instanceMatrix.array as Float32Array;
    const t = this.arcTint.array as Float32Array;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-4;
    const o = i * 16;
    m[o] = dx; m[o + 1] = 0; m[o + 2] = dz; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = (-dz / len) * w; m[o + 9] = 0; m[o + 10] = (dx / len) * w; m[o + 11] = 0;
    m[o + 12] = (ax + bx) / 2; m[o + 13] = y; m[o + 14] = (az + bz) / 2; m[o + 15] = 1;
    const q = i * 4;
    t[q] = c.r; t[q + 1] = c.g; t[q + 2] = c.b; t[q + 3] = a;
  }

  /** `n` segments along island `p`'s path from `tick` over `ticks`; dashed drops every third. Returns the next slot. */
  private arc(n: number, p: View['islands'][number], tick: number, ticks: number, segs: number, dashed: boolean, w: number, c: Color, k0: number, fade: number): number {
    const y = PLANE_Y.sky + 0.55;
    islandAt(p, tick, PT);
    let px = PT.x;
    let py = PT.y;
    for (let s = 1; s <= segs; s++) {
      const q = islandAt(p, tick + (s * ticks) / segs, PT);
      if (!dashed || s % 3 !== 0) this.seg(n++, wx(px, this.size), wz(py, this.size), wx(q.x, this.size), wz(q.y, this.size), y, w, c, k0 * (1 - (s / segs) * fade));
      px = q.x;
      py = q.y;
    }
    return n;
  }

  /**
   * Drift rings and path previews. Rings: every island, owner-tinted (`side` maps island id → owner), stronger while
   * the Sky is focused (`all`) and bold for hovered / selected ones. Previews: while the Sky is focused every island
   * shows a short solid lead in its travel direction; highlighted islands (on any plane) show the dashed next
   * minute with time ticks at +15/30/45/60 s (labelled by the overlay). `deaths`: playing deaths' storm openings.
   */
  paths(view: View | undefined, tick: number, all: boolean, highlight: ReadonlySet<string>, side: (id: string) => Side,
    tracks: ReadonlyMap<string, Track> | undefined, models: Object3D, eye?: Vector3, deaths?: DeathPlayer): void {
    this.weather.cutaways(tracks, models, this.fogField, eye, deaths);
    this.weather.frame(tick);
    let n = 0;
    let rings = 0;
    if (view && fadeValue.sky > 0.03) {
      for (const p of view.islands) {
        if (rings >= ISLAND_CAP) break;
        const hi = highlight.has(p.id);
        const owner = side(p.id);
        const c = owner === 'neutral' ? NEUTRAL_INK : sideColor(owner);
        this.ringData.setXYZW(rings, wx(p.cx, this.size), wz(p.cy, this.size), p.r, hi ? RING_HI_W : RING_W);
        this.ringTint.setXYZW(rings++, c.r, c.g, c.b, hi ? 0.95 : all ? 0.5 : 0.1);
        // Keep the original ring visible, but never invent drift ETAs while lowering, held or raising.
        if (p.pausedAt !== undefined) continue;
        if (hi) {
          if (n + ARC_SEGS + ARC_TICKS > ARC_CAP) continue;
          n = this.arc(n, p, tick, PATH_AHEAD_S * TICK_RATE, ARC_SEGS, true, 0.32, c, 1, 0.7);
          // time ticks across the path at +15/30/45/60 s (the last one longer)
          for (let j = 1; j <= ARC_TICKS; j++) {
            const q = islandAt(p, tick + (j * PATH_AHEAD_S * TICK_RATE) / ARC_TICKS, PT);
            const dx = q.x - p.cx;
            const dy = q.y - p.cy;
            const l = Math.hypot(dx, dy) || 1;
            const m = j === ARC_TICKS ? 1.1 : 0.6;
            this.seg(n++, wx(q.x, this.size) - (dx / l) * m, wz(q.y, this.size) - (dy / l) * m, wx(q.x, this.size) + (dx / l) * m, wz(q.y, this.size) + (dy / l) * m, PLANE_Y.sky + 0.55, 0.26, c, 1);
          }
        } else if (all && n + LEAD_SEGS <= ARC_CAP) n = this.arc(n, p, tick, LEAD_S * TICK_RATE, LEAD_SEGS, false, 0.24, c, 0.85, 1);
      }
    }
    this.rings.count = rings;
    this.ringData.needsUpdate = this.ringTint.needsUpdate = true;
    this.arcs.count = n;
    this.arcs.instanceMatrix.needsUpdate = true;
    this.arcTint.needsUpdate = true;
  }

  frame(t: number): void {
    const storms = this.weather.cloudField;
    for (let i = 0; i < this.cloudData.length; i++) {
      const c = this.cloudData[i]!;
      const a = c.a + t * c.s;
      const x = Math.cos(a) * c.r, z = Math.sin(a) * c.r;
      // White deck puffs drifting into a storm shrink into it rather than poke through the dark fused mass.
      let keep = 1;
      for (let j = 0; j < storms.count; j++) {
        const s = storms.centres[j]!, opacity = storms.states[j]!.x;
        const d = Math.hypot(x - s.x, z - s.z), from = s.w * 0.7, to = s.w * 1.1 + c.sx;
        const k = Math.min(1, Math.max(0, (d - from) / (to - from)));
        keep = Math.min(keep, 1 - opacity + opacity * k * k * (3 - 2 * k));
      }
      tmp.position.set(x, PLANE_Y.sky + c.h, z);
      tmp.scale.setScalar(c.sx * keep);
      tmp.rotation.set(0, -a, 0);
      tmp.updateMatrix();
      this.clouds[i % this.clouds.length]!.setMatrixAt(Math.floor(i / this.clouds.length), tmp.matrix);
    }
    for (const m of this.clouds) m.instanceMatrix.needsUpdate = true;
  }
}
