/**
 * The Orbit page (indigo paper, chalk lines): the two rotating sun wedges as a soft additive warm wash with broad
 * dawn/dusk gradients and a faint ink terminator, a quiet chalk survey grid, pebbles circling every
 * asteroid and the tugs' tow ropes, and the derelict ruin at the centre (`derelict.ts`). The home map preview adds the
 * map's asteroid approach regions (loose ink-sketch outlines over a light wash, short strokes flowing along their
 * drift), shown only while the preview focuses the Orbit. Asteroids, the core, arrays and tugs are entities (`models.ts`).
 */
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  type Node,
} from 'three/webgpu';
import { abs, atan, clamp, color, exp, float, floor, fract, instancedDynamicBufferAttribute, max, min, mix, positionGeometry, positionWorld, sin, smoothstep, time, uniform, uv } from 'three/tsl';
import { ECON, PLANE_Y, SUN, footprint, isNeutralKind, sunHalfWidth, sunSpeedOf, type MatchData, type View } from '@agent-command/game/contract';
import { FADE, fadeValue } from './fade.ts';
import { fbm, hash2, sideColor, wx, wz } from './common.ts';
import { inkMaterial, overlay, rgb, seen, veil } from './materials.ts';
import type { FogField } from './fog.ts';
import { RIG, merge } from './models.ts';
import { SUN_AHEAD_S } from './plan.ts';
import type { Track } from './entities.ts';
import { rockScale } from './asteroid.ts';
import { DerelictRuin } from './derelict.ts';

const tmp = new Object3D();

/** Pebbles circling each asteroid (cap: 32 asteroids, `entities.ts` CAP). */
const PEBBLES = 5;
const PEBBLE_CAP = 32 * PEBBLES;
/** Rope segments per tug tether; ropes drawn at most. */
const ROPE_SEGS = 14;
const ROPE_CAP = 32;
/** Chalk (#e9dcc4, the Orbit's line colour) for the rope's light strands. */
const CHALK_RGB = [0.91, 0.86, 0.77] as const;
/** One fixed slot per visible ship; overflow drops cosmetics, never a hull. */
const ENGINE_CAP = 600;
const WAKE_SAMPLES = 18;
const WAKE_STEP = 0.055;
const ENGINE_INSTANCES = ENGINE_CAP * (WAKE_SAMPLES + 1);
const WAKE_LIFE = WAKE_STEP * WAKE_SAMPLES;
/** Approach regions drawn at most (MatchData.orbitRegions' cap). */
const REGION_CAP = 64;

/** A small faceted rock (unit radius). */
function pebbleGeometry(): BufferGeometry {
  const g = new IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const d = 1 + fbm(x * 1.7 + 2, y * 1.7 + z, 3) * 0.8;
    p.setXYZ(i, x * d, y * d * 0.75, z * d);
  }
  return merge([{ geo: g, paint: '#ffffff' }]);
}

export class OrbitLayer {
  readonly group = new Group();
  /** Bearing (rad) of one lit wedge's centre line, smoothly advanced between views; the others follow every 2π / wedges. */
  readonly sunAngle = uniform(SUN.startAngle);
  // Defaults until the first view's match data arrives: a two-slot map's wedge count (one wedge per slot).
  private readonly sunWedges = uniform(2);
  readonly sunHalf = uniform(sunHalfWidth(2));
  /** Wedge rotation over the preview horizon (rad): the dawn band is where light arrives within SUN_AHEAD_S. */
  private readonly sunAhead = uniform(sunSpeedOf(ECON.sunPeriodTicks, 2) * SUN_AHEAD_S);
  private readonly pebbles: InstancedMesh;
  private readonly ropes: InstancedMesh;
  private readonly ropeTint: InstancedBufferAttribute;
  private readonly engines: InstancedMesh;
  private readonly engineTint: InstancedBufferAttribute;
  private readonly wakeOwners = new Array<Track | undefined>(ENGINE_CAP);
  private readonly wakeFree = new Uint16Array(ENGINE_CAP);
  private wakeFreeN = ENGINE_CAP;
  private readonly wakeEpoch = new Uint32Array(ENGINE_CAP);
  private readonly wakeHead = new Uint8Array(ENGINE_CAP);
  private readonly wakeCount = new Uint8Array(ENGINE_CAP);
  private readonly wakeTime = new Float64Array(ENGINE_CAP * WAKE_SAMPLES);
  private readonly wakeX = new Float32Array(ENGINE_CAP * WAKE_SAMPLES);
  private readonly wakeY = new Float32Array(ENGINE_CAP * WAKE_SAMPLES);
  private readonly wakeZ = new Float32Array(ENGINE_CAP * WAKE_SAMPLES);
  /** Read by World.prepareFirstFrame, which warms a detached copy; only this layer changes it. */
  readonly regions: InstancedMesh;
  /** Per region: width, height (tiles) and unit drift direction. */
  private readonly regionData: InstancedBufferAttribute;
  private wakeFrame = -1;
  /** The derelict ruin (`derelict.ts`): built from the match's public geometry, turned by `World` every frame. */
  readonly ruin: DerelictRuin;

  readonly size: number;

  constructor(size: number, fogField?: FogField) {
    this.size = size;
    const f = FADE.orbit;
    const px = positionWorld.x;
    const pz = positionWorld.z;
    const bearing = atan(pz, px);
    const radius = px.mul(px).add(pz.mul(pz)).sqrt();
    // signed angular offset from the nearest wedge centre line, folded onto ±π / wedges (every wedge at once)
    const period = float(Math.PI * 2).div(this.sunWedges);
    const offset = (a: Node<'float'>) => fract(bearing.sub(a).div(period).add(0.5)).sub(0.5).mul(period);
    const now = abs(offset(this.sunAngle));
    const soon = abs(offset(this.sunAngle.add(this.sunAhead)));
    // Soft edges stay centred on `sunHalf` (half-wash exactly at the rule's boundary) so lit ground reads true for arrays.
    const lit = float(1).sub(smoothstep(this.sunHalf.sub(0.025), this.sunHalf.add(0.025), now));
    const litSoon = float(1).sub(smoothstep(this.sunHalf.sub(0.025), this.sunHalf.add(0.025), soon));
    // Dawn/dusk are broad gradients over the SUN_AHEAD_S sweep (rad), fading to zero at its far end so no second edge is
    // drawn: dawn brightens toward the arriving edge in the dark, dusk dims the wash toward the departing edge.
    const reach = max(abs(this.sunAhead), 1e-3);
    const dawn = litSoon.mul(float(1).sub(lit)).mul(float(1).sub(smoothstep(this.sunHalf, this.sunHalf.add(reach), now)));
    const dusk = lit.mul(float(1).sub(litSoon)).mul(smoothstep(this.sunHalf.sub(reach), this.sunHalf, now));
    // a faint continuous ink terminator on the current edge (tiles from the edge line), never dashed or animated
    const edge = now.sub(this.sunHalf).mul(radius);
    const term = exp(edge.mul(edge).mul(-10)).mul(smoothstep(1, 4, radius));
    const g = min(fract(px.div(4)), fract(pz.div(4)));
    const grid = float(1).sub(smoothstep(0, 0.025, g));
    // a warm daylight wash on the indigo page (additive), rosier toward dusk; a quiet chalk survey grid beneath
    const sheet = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    sheet.blending = AdditiveBlending;
    const day = mix(color('#f4dcaa'), color('#eab394'), dusk.mul(0.6)).mul(lit.mul(float(0.13).sub(dusk.mul(0.05))));
    const sun = day.add(color('#eeb98c').mul(dawn.mul(0.045))).add(color('#e9dcc4').mul(term.mul(0.07)));
    sheet.colorNode = sun.mul(seen('orbit', fogField).mul(0.5).add(0.5)).add(color('#b9bfe6').mul(grid.mul(0.022))).mul(f.focus.mul(0.7).add(0.3)).mul(f.alpha);
    sheet.opacityNode = float(1);
    const band = new Mesh(new PlaneGeometry(this.size, this.size, 1, 1).rotateX(-Math.PI / 2), sheet);
    band.position.y = PLANE_Y.orbit - 0.3;
    band.renderOrder = -1;
    this.group.add(band);
    this.group.add(veil('orbit', PLANE_Y.orbit - 0.2, size, fogField));

    // debris: cel pebbles with chalk outlines, circling their asteroid
    this.pebbles = new InstancedMesh(pebbleGeometry(), inkMaterial('orbit', rgb('#a39484'), { fog: false }), PEBBLE_CAP);
    this.pebbles.instanceMatrix.setUsage(DynamicDrawUsage);
    this.pebbles.count = 0;
    this.pebbles.frustumCulled = false;
    this.group.add(this.pebbles);

    // tow ropes: flat chalk-and-team striped ribbons that sag and sway
    this.ropeTint = new InstancedBufferAttribute(new Float32Array(ROPE_CAP * ROPE_SEGS * 4), 4);
    this.ropeTint.setUsage(DynamicDrawUsage);
    const rt = instancedDynamicBufferAttribute<'vec4'>(this.ropeTint, 'vec4');
    const rm = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    rm.colorNode = rt.xyz;
    rm.opacityNode = rt.w.mul(f.alpha);
    this.ropes = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), rm, ROPE_CAP * ROPE_SEGS);
    this.ropes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.ropes.count = 0;
    this.ropes.frustumCulled = false;
    this.ropes.renderOrder = 5;
    this.group.add(this.ropes);

    // One reusable draw for nozzle glow and curved wakes. Both CPU ownership and fragment fog gate the marks.
    this.engineTint = new InstancedBufferAttribute(new Float32Array(ENGINE_INSTANCES * 4), 4);
    this.engineTint.setUsage(DynamicDrawUsage);
    const et = instancedDynamicBufferAttribute<'vec4'>(this.engineTint, 'vec4');
    const em = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    em.blending = AdditiveBlending;
    em.colorNode = et.xyz.mul(1.8);
    const softEdge = float(1).sub(smoothstep(0.1, 0.5, abs(uv().y.sub(0.5))));
    em.opacityNode = et.w.mul(softEdge).mul(FADE.orbit.alpha).mul(seen('orbit', fogField));
    this.engines = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), em, ENGINE_INSTANCES);
    this.engines.name = 'orbit-engines';
    this.engines.instanceMatrix.setUsage(DynamicDrawUsage);
    this.engines.count = 0;
    this.engines.frustumCulled = false;
    this.engines.renderOrder = 4;
    this.group.add(this.engines);
    for (let i = 0; i < ENGINE_CAP; i++) this.wakeFree[i] = i;

    // Asteroid approach regions, in region-local tiles (unit plane scaled to width × height).
    this.regionData = new InstancedBufferAttribute(new Float32Array(REGION_CAP * 4), 4);
    const rd = instancedDynamicBufferAttribute<'vec4'>(this.regionData, 'vec4');
    const lx = positionGeometry.x.mul(rd.x);
    const lz = positionGeometry.z.mul(rd.y);
    const inside = min(float(0.5).sub(abs(positionGeometry.x)).mul(rd.x), float(0.5).sub(abs(positionGeometry.z)).mul(rd.y));
    // Two loose pen passes inset from the edge (tiles), wobbling with world position so every box is drawn by hand;
    // pen pressure swells and thins smoothly along the line instead of breaking into dashes.
    const qx = positionWorld.x;
    const qz = positionWorld.z;
    const wobbleA = sin(qx.mul(1.3).add(qz.mul(0.7))).mul(0.04).add(sin(qx.mul(0.37).sub(qz.mul(0.53)).add(1.7)).mul(0.07));
    const wobbleB = sin(qx.mul(0.9).sub(qz.mul(1.1)).add(4.1)).mul(0.05).add(sin(qz.mul(0.31).add(qx.mul(0.47))).mul(0.08));
    const passA = float(1).sub(smoothstep(0.025, 0.1, abs(inside.sub(0.18).add(wobbleA))));
    const passB = float(1).sub(smoothstep(0.02, 0.07, abs(inside.sub(0.32).add(wobbleB))));
    const pressure = sin(qx.add(qz).mul(0.45)).mul(0.25).add(0.75);
    const outline = passA.mul(pressure).add(passB.mul(0.4));
    // A light wash that pools toward the outline, as ink does on paper.
    const wash = float(1).sub(smoothstep(0.2, 2, inside)).mul(0.5).add(0.5);
    // Short drift strokes in staggered rows (cells 2.4 × 1.2 tiles): each tapers from a hairline tail to a fuller,
    // slightly hooked head and the field flows slowly along the drift (tile y is world z).
    const along = lx.mul(rd.z).add(lz.mul(rd.w)).sub(time.mul(0.25));
    const across = lz.mul(rd.z).sub(lx.mul(rd.w));
    const cellAlong = fract(along.div(2.4).add(fract(floor(across.div(1.2)).mul(0.618)))).sub(0.5).mul(2.4);
    const cellAcross = fract(across.div(1.2)).sub(0.5).mul(1.2);
    const head = clamp(cellAlong.add(0.35).div(0.65), 0, 1);
    const extent = smoothstep(-0.42, -0.3, cellAlong).mul(float(1).sub(smoothstep(0.26, 0.34, cellAlong)));
    const width = head.mul(0.04).add(0.012);
    const stroke = float(1).sub(smoothstep(width, width.add(0.035), abs(cellAcross.add(head.mul(head).mul(0.05)))));
    const strokes = stroke.mul(extent).mul(smoothstep(0.45, 1.1, inside));
    const regionMat = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    regionMat.blending = AdditiveBlending;
    regionMat.colorNode = color('#e3d6bd');
    regionMat.opacityNode = outline.mul(0.26).add(strokes.mul(0.2)).add(wash.mul(0.035)).mul(f.focus.mul(0.6).add(0.4)).mul(f.alpha);
    this.regions = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), regionMat, REGION_CAP);
    this.regions.name = 'orbit-regions';
    this.regions.count = 0;
    this.regions.frustumCulled = false;
    this.regions.renderOrder = 3;
    // Hidden until the home preview focuses the Orbit (`setRegionsFocused`).
    this.regions.visible = false;
    this.group.add(this.regions);
    this.ruin = new DerelictRuin(size);
    this.group.add(this.ruin.group);
  }

  update(view: View, sinceView: number): void {
    const s = view.match!.sun;
    this.sunAngle.value = view.sun.angle + s.speed * sinceView;
    this.sunHalf.value = s.half;
    this.sunWedges.value = s.wedges;
    this.sunAhead.value = s.speed * SUN_AHEAD_S;
    this.ruin.set(view.match!.derelict, view.match!.mapSeed);
  }

  /** The map's asteroid approach regions (home map preview); `[]` clears them. Built once per map, not per frame. */
  setRegions(regions: MatchData['orbitRegions']): void {
    const n = Math.min(REGION_CAP, regions.length);
    const data = this.regionData.array as Float32Array;
    tmp.rotation.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const r = regions[i]!;
      tmp.position.set(wx(r.x, this.size), PLANE_Y.orbit - 0.25, wz(r.y, this.size));
      tmp.scale.set(r.width, 1, r.height);
      tmp.updateMatrix();
      this.regions.setMatrixAt(i, tmp.matrix);
      data[i * 4] = r.width;
      data[i * 4 + 1] = r.height;
      data[i * 4 + 2] = r.dx;
      data[i * 4 + 3] = r.dy;
    }
    this.regions.count = n;
    this.regions.instanceMatrix.needsUpdate = true;
    this.regionData.needsUpdate = true;
  }

  /** Show the loaded regions only while the home preview focuses the Orbit; never touches their buffers or material. */
  setRegionsFocused(focused: boolean): void {
    this.regions.visible = focused;
  }

  /** One rope segment (a flat quad `w` wide) between two world points. */
  private rope(i: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, r: number, g: number, b: number, a: number): void {
    const m = this.ropes.instanceMatrix.array as Float32Array;
    const t = this.ropeTint.array as Float32Array;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-4;
    const o = i * 16;
    m[o] = dx; m[o + 1] = by - ay; m[o + 2] = dz; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = (-dz / len) * w; m[o + 9] = 0; m[o + 10] = (dx / len) * w; m[o + 11] = 0;
    m[o + 12] = (ax + bx) / 2; m[o + 13] = (ay + by) / 2; m[o + 14] = (az + bz) / 2; m[o + 15] = 1;
    const q = i * 4;
    t[q] = r; t[q + 1] = g; t[q + 2] = b; t[q + 3] = a;
  }

  /** Flat engine ribbon; writes directly into the persistent instance buffers. */
  private engine(i: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, tr: Track, alpha: number): void {
    const m = this.engines.instanceMatrix.array as Float32Array;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-4;
    const o = i * 16;
    m[o] = dx; m[o + 1] = by - ay; m[o + 2] = dz; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = (-dz / len) * width; m[o + 9] = 0; m[o + 10] = (dx / len) * width; m[o + 11] = 0;
    m[o + 12] = (ax + bx) / 2; m[o + 13] = (ay + by) / 2; m[o + 14] = (az + bz) / 2; m[o + 15] = 1;
    const c = sideColor(tr.e.side);
    this.engineTint.setXYZW(i, 0.85 + c.r * 0.15, 0.55 + c.g * 0.3, 0.25 + c.b * 0.45, alpha);
  }

  /** Wake history is owned by visible tracks only: fog/death/plane changes discard it immediately. */
  private followEngines(tracks: ReadonlyMap<string, Track>, t: number): void {
    const active = fadeValue.orbit > 0.03;
    const interrupted = this.wakeFrame < 0 || t < this.wakeFrame || t - this.wakeFrame > 0.25;
    this.wakeFrame = t;
    for (let i = 0; i < ENGINE_CAP; i++) {
      const tr = this.wakeOwners[i];
      if (!tr) continue;
      const n = this.wakeCount[i]!;
      const expired = tr.speed < 0.25 && (n === 0 || t - this.wakeTime[i * WAKE_SAMPLES + this.wakeHead[i]!]! >= WAKE_LIFE);
      if (!active || tracks.get(tr.e.id) !== tr || !tr.visible || tr.e.cloaked || tr.e.plane !== 'orbit' || tr.dive > 0 || expired) {
        tr.wakeSlot = -1;
        this.wakeOwners[i] = undefined;
        this.wakeFree[this.wakeFreeN++] = i;
      } else if (interrupted || this.wakeEpoch[i] !== tr.motionEpoch) {
        this.wakeCount[i] = 0;
        this.wakeEpoch[i] = tr.motionEpoch;
      }
    }
    let count = 0;
    if (active) for (const tr of tracks.values()) {
      const e = tr.e;
      if (!tr.visible || e.cloaked || e.plane !== 'orbit' || tr.dive > 0 || isNeutralKind(e.kind) || footprint(e.kind)) continue;
      let slot = tr.wakeSlot;
      if (slot < 0 || this.wakeOwners[slot] !== tr) {
        if (tr.speed < 0.25 || this.wakeFreeN === 0) continue;
        slot = this.wakeFree[--this.wakeFreeN]!;
        tr.wakeSlot = slot;
        this.wakeOwners[slot] = tr;
        this.wakeEpoch[slot] = tr.motionEpoch;
        this.wakeCount[slot] = 0;
      }
      const base = slot * WAKE_SAMPLES;
      let head = this.wakeHead[slot]!;
      let n = this.wakeCount[slot]!;
      const headingX = Math.cos(tr.heading);
      const headingZ = Math.sin(tr.heading);
      const nozzle = (RIG[e.kind].flame?.x ?? -0.32) * tr.scale;
      const x = wx(tr.rx, this.size) + headingX * nozzle;
      const y = tr.wy + 0.02;
      const z = wz(tr.ry, this.size) + headingZ * nozzle;
      const moving = tr.speed >= 0.25;
      if (moving && (n === 0 || t - this.wakeTime[base + head]! >= WAKE_STEP)) {
        head = n === 0 ? 0 : (head + 1) % WAKE_SAMPLES;
        const j = base + head;
        this.wakeX[j] = x; this.wakeY[j] = y; this.wakeZ[j] = z; this.wakeTime[j] = t;
        this.wakeHead[slot] = head;
        n = Math.min(n + 1, WAKE_SAMPLES);
        this.wakeCount[slot] = n;
      }
      if (moving) {
        const length = (0.16 + Math.min(tr.speed, 5) * 0.055) * tr.scale;
        this.engine(count++, x - headingX * length, y, z - headingZ * length, x, y, z, 0.17 * tr.scale, tr, 0.7);
      }
      // Join actual past nozzle positions, never a rigid stick rotated into the newest heading.
      let px = x, py = y, pz = z;
      for (let j = 0; j < n; j++) {
        const k = base + (head - j + WAKE_SAMPLES) % WAKE_SAMPLES;
        const age = t - this.wakeTime[k]!;
        if (age >= WAKE_LIFE) break;
        const nx = this.wakeX[k]!, ny = this.wakeY[k]!, nz = this.wakeZ[k]!;
        const life = 1 - age / WAKE_LIFE;
        if (Math.hypot(nx - px, nz - pz) > 0.005)
          this.engine(count++, nx, ny, nz, px, py, pz, 0.1 * tr.scale * life, tr, 0.28 * life * life);
        px = nx; py = ny; pz = nz;
      }
    }
    this.engines.count = count;
    this.engines.instanceMatrix.needsUpdate = true;
    this.engineTint.needsUpdate = true;
  }

  /** Tug tethers and asteroid debris from the interpolated tracks; call after `Entities.frame` (same positions). */
  follow(tracks: ReadonlyMap<string, Track>, t: number): void {
    let np = 0;
    this.followEngines(tracks, t);
    let nr = 0;
    if (fadeValue.orbit > 0.02) {
      for (const tr of tracks.values()) {
        if (!tr.visible || tr.e.plane !== 'orbit') continue;
        if (tr.e.kind === 'asteroid' && np + PEBBLES <= PEBBLE_CAP) {
          const scale = rockScale(tr.e);
          const count = tr.e.rockSize === 'pebble' ? 2 : PEBBLES;
          for (let j = 0; j < count; j++) {
            const a = tr.phase + j * 1.9 + t * (0.25 + hash2(j, 41) * 0.3);
            const r = (1.15 + hash2(j, 42) * 0.6) * scale;
            tmp.position.set(wx(tr.rx, this.size) + Math.cos(a) * r, tr.wy + (hash2(j, 43) - 0.5) * 0.5, wz(tr.ry, this.size) + Math.sin(a) * r);
            tmp.rotation.set(t * 0.7 + j, t * 0.5 + tr.phase, 0);
            tmp.scale.setScalar((0.07 + hash2(j, 44) * 0.1) * scale);
            tmp.updateMatrix();
            this.pebbles.setMatrixAt(np++, tmp.matrix);
          }
        } else if (tr.e.kind === 'tug' && tr.e.link && nr < ROPE_CAP) {
          const o = tracks.get(tr.e.link);
          if (!o?.visible) continue;
          const ax = wx(tr.rx, this.size);
          const az = wz(tr.ry, this.size);
          const dx = wx(o.rx, this.size) - ax;
          const dz = wz(o.ry, this.size) - az;
          const dy = o.wy - tr.wy;
          const len = Math.hypot(dx, dz) || 1e-4;
          // sideways sway and a slight droop, both zero at the ends
          const sway = Math.sin(t * 2.6 + tr.phase) * Math.min(0.35, len * 0.08);
          const c = sideColor(tr.e.side);
          let px = ax;
          let py = tr.wy;
          let pz = az;
          for (let s = 1; s <= ROPE_SEGS; s++) {
            const u = s / ROPE_SEGS;
            const bow = Math.sin(Math.PI * u);
            const qx = ax + dx * u - (dz / len) * sway * bow;
            const qy = tr.wy + dy * u - 0.2 * bow;
            const qz = az + dz * u + (dx / len) * sway * bow;
            const chalk = s % 2 === 0;
            this.rope(nr * ROPE_SEGS + s - 1, px, py, pz, qx, qy, qz, 0.07, chalk ? CHALK_RGB[0] : c.r, chalk ? CHALK_RGB[1] : c.g, chalk ? CHALK_RGB[2] : c.b, 0.95);
            px = qx;
            py = qy;
            pz = qz;
          }
          nr++;
        }
      }
    }
    this.pebbles.count = np;
    this.pebbles.instanceMatrix.needsUpdate = true;
    this.ropes.count = nr * ROPE_SEGS;
    this.ropes.instanceMatrix.needsUpdate = true;
    this.ropeTint.needsUpdate = true;
  }
}

