/**
 * Cosmetic ore crystals on ore-bearing Sky islands, drawn only for disclosed reserves (unknown never renders as a
 * full deposit) and rain-darkened while a storm covers the island. No entities, orders or economy; every island
 * shares one material and shader program.
 */
import { BufferGeometry, Color, type Node, ConeGeometry, CylinderGeometry, DynamicDrawUsage, InstancedMesh, MeshBasicNodeMaterial, Object3D, Quaternion, Ray, Vector2, Vector3 } from 'three/webgpu';
import { abs, attribute, float, max, min, mix, positionGeometry, sin, smoothstep, step, uniform } from 'three/tsl';
import type { Entity } from '@agent-command/game/contract';
import { clamp, hash2 } from './common.ts';
import { inkMaterial, rgb, type V3 } from './materials.ts';
import { merge, turnAngle } from './models.ts';
import { INK, ORE_HEAP_PAINT, PENCIL, UNIT_PAINT } from './palette.ts';

const CLUSTERS = 5;
const SHARDS = 4;
const TIERS = 3;
const CAP = CLUSTERS * SHARDS;
const UP = new Vector3(0, 1, 0);
const pose = new Object3D();
const spin = new Quaternion();
const direction = new Vector3();
const ray = new Ray();
const a = new Vector3(), b = new Vector3(), c = new Vector3();
const ab = new Vector3(), ac = new Vector3(), hit = new Vector3(), face = new Vector3();
const root = new Vector3(), normal = new Vector3();
/** Cluster frame, separate from skin()'s triangle scratch: flanking shards re-probe the rock inside the shard loop. */
const outward = new Vector3(), tangent = new Vector3();
/** Rain-darkened stone, the same `wet` pigment islandStormPaint applies to turf and leaves. */
const WET = '#869ac4';
export const ORE_WET = new Color(WET);
const DRY = new Color(1, 1, 1);
/** Scratch tint for a partly wet island (shared: islands update one at a time). */
const WET_TINT = new Color();

/** InstancedMesh.instanceColor multiplies the shared material's output, so every ore mesh (and the warm-up template)
 * always carries one: dry is white, a storm is ORE_WET. Same program for all islands, per-island tint. */
function wetInstances(mesh: InstancedMesh, count: number): void {
  for (let i = 0; i < count; i++) mesh.setColorAt(i, DRY);
  mesh.instanceColor!.setUsage(DynamicDrawUsage);
}

let sharedGeometry: BufferGeometry | undefined;
let sharedMaterial: MeshBasicNodeMaterial | undefined;

/** One cached, flat-faceted mineral prism: a dark root, teal shaft and pale pointed termination. */
function crystalGeometry(): BufferGeometry {
  return (sharedGeometry ??= merge([
    { geo: new CylinderGeometry(0.23, 0.19, 0.64, 5).translate(0, 0.32, 0), paint: UNIT_PAINT.ore, glow: 0.05 },
    { geo: new ConeGeometry(0.23, 0.36, 5).translate(0, 0.82, 0), paint: ORE_HEAP_PAINT.crystal, glow: 0.15 },
    { geo: new CylinderGeometry(0.19, 0.24, 0.12, 5).translate(0, 0.02, 0), paint: ORE_HEAP_PAINT.rubble },
  ]));
}

function crystalMaterial(): MeshBasicNodeMaterial {
  if (!sharedMaterial) {
    const paint = attribute<'vec3'>('paint', 'vec3') as V3;
    // These instances exist only for disclosed reserves. Never turn public capacity into a fogged full deposit.
    sharedMaterial = inkMaterial('sky', paint, { fog: false, glow: paint.mul(attribute<'float'>('glow', 'float').mul(0.4)) as V3 });
  }
  return sharedMaterial;
}

/** Canonical draw for the existing shader warm-up, including views whose ore amounts are all unknown. */
export function islandOreTemplate(): InstancedMesh {
  const mesh = new InstancedMesh(crystalGeometry(), crystalMaterial(), 1);
  mesh.name = 'island-ore-template';
  wetInstances(mesh, 1);
  mesh.count = 0;
  return mesh;
}

/** Probe the actual island draw, not a second procedural approximation. Reject vertical hanging roots and back faces. */
function skin(geometry: BufferGeometry, bearing: number, y: number): boolean {
  const x = Math.cos(bearing), z = Math.sin(bearing);
  ray.origin.set(x * 8, y, z * 8);
  ray.direction.set(-x, 0, -z);
  const positions = geometry.getAttribute('position'), index = geometry.getIndex();
  const count = index?.count ?? positions.count;
  let nearest = Infinity;
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(positions, index ? index.getX(i) : i);
    b.fromBufferAttribute(positions, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(positions, index ? index.getX(i + 2) : i + 2);
    if (!ray.intersectTriangle(a, b, c, true, hit)) continue;
    face.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
    if (face.y > -0.22) continue;
    const distance = ray.origin.distanceToSquared(hit);
    if (distance >= nearest) continue;
    nearest = distance;
    root.copy(hit);
    normal.copy(face);
  }
  return Number.isFinite(nearest);
}

/** A cosmetic deposit attached to one permanent island. There are no mineral entities, orders or economy here. */
export class IslandOre {
  readonly mesh: InstancedMesh;
  /** x = disclosed remaining fraction, y = knowledge (0 unknown, 1 observed, including remembered exhaustion). */
  readonly reserve = uniform(new Vector2());
  /** Island turn (cos, sin) and vein phase as values, not literals: every ore island compiles to one shared program. */
  private readonly pattern = uniform(new Vector3());
  private readonly rest = new Float32Array(CAP * 16);
  private readonly tier = new Uint8Array(CAP);
  private count = 0;
  private fraction = -2;
  private exhausted = false;
  private wet = 0;

  constructor(id: string, geometry: BufferGeometry, seed: number, turns: number) {
    this.pattern.value.set(Math.cos(turnAngle(turns)), Math.sin(turnAngle(turns)), seed * 1.37);
    this.mesh = new InstancedMesh(crystalGeometry(), crystalMaterial(), CAP);
    this.mesh.name = `island-ore-${id}`;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    wetInstances(this.mesh, CAP);
    const yaw = turnAngle(turns);
    // 3-5 clusters of 2-4 shards around the rim, leaning outward past the turf so they read from the RTS camera. Shard
    // tier 0 (the big centre one) outlasts the flanking ones, so a known reserve visibly thins each cluster.
    const clusters = 3 + Math.floor(hash2(seed, 700) * 3);
    for (let cluster = 0; cluster < clusters; cluster++) {
      const bearing = (cluster + hash2(seed, 710) * 0.6) * Math.PI * 2 / clusters - yaw + (hash2(seed, cluster + 715) - 0.5) * 0.5;
      const height = -0.6 - hash2(seed, cluster + 720) * 0.3;
      if (!skin(geometry, bearing, height)) continue;
      // horizontal outward heading of the rock face, and its tangent for spreading the shards
      outward.set(normal.x, 0, normal.z);
      if (outward.lengthSq() < 1e-4) outward.set(Math.cos(bearing), 0, Math.sin(bearing));
      outward.normalize();
      tangent.set(-outward.z, 0, outward.x);
      const shards = 2 + Math.floor(hash2(seed, cluster + 725) * 3);
      for (let k = 0; k < shards; k++) {
        const tier = Math.min(k, TIERS - 1), side = k === 0 ? 0 : k % 2 ? 1 : -1;
        const lean = side * (0.35 + hash2(seed + cluster, k + 735) * 0.25);
        direction.copy(outward).multiplyScalar(0.8).addScaledVector(tangent, lean).setY(-0.55 - hash2(seed + cluster, k + 745) * 0.3).normalize();
        // flanking shards are seated on their own patch of the drawn rock, not floated off the centre one's tangent
        if (side && !skin(geometry, bearing + side * (0.08 + k * 0.02), height)) continue;
        pose.position.copy(root).addScaledVector(direction, -0.1);
        pose.quaternion.setFromUnitVectors(UP, direction).multiply(spin.setFromAxisAngle(UP, hash2(seed + cluster, k + 730) * Math.PI * 2 + yaw));
        const width = (1.75 + hash2(seed + cluster, k + 740) * 0.35) * (1 - tier * 0.22);
        const length = (2.0 + hash2(seed, cluster * 4 + k + 750) * 0.5) * (1 - tier * 0.28);
        pose.scale.set(width, length, width);
        pose.updateMatrix();
        pose.matrix.toArray(this.rest, this.count * 16);
        this.tier[this.count++] = tier;
      }
    }
  }

  /** `storm` is the island grove's fog-gated, eased exposure (x, 0..1); x only, never per-cell weather truth. Uploads
   * on change. */
  weather(storm: number): void {
    if (storm === this.wet) return;
    this.wet = storm;
    const tint = WET_TINT.copy(DRY).lerp(ORE_WET, storm);
    for (let i = 0; i < CAP; i++) this.mesh.setColorAt(i, tint);
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** Veins are pigment on the actual rock, never a floating decal or another terrain shell. `storm` is the island's
   * grove storm uniform: veins, ribs and cracks are stone, so they darken with it (turf/leaf paint skips stone). */
  paint(base: V3, storm?: Node<'vec2'>): V3 {
    const c = this.pattern.x, s = this.pattern.y, phase = this.pattern.z;
    const x = positionGeometry.x.mul(c).sub(positionGeometry.z.mul(s));
    const z = positionGeometry.x.mul(s).add(positionGeometry.z.mul(c));
    const y = positionGeometry.y;
    const bedding = abs(sin(y.mul(4.2).add(sin(x.mul(1.7).add(phase)).mul(0.8)).add(sin(z.mul(1.9).sub(phase)).mul(0.65))));
    const branches = abs(sin(x.mul(2.2).add(z.mul(1.4)).add(sin(y.mul(3.1)).mul(0.65)).add(phase)));
    const seam = max(float(1).sub(smoothstep(0.08, 0.24, bedding)), float(1).sub(smoothstep(0.03, 0.12, branches)).mul(0.8));
    // The cliff band under the cap and the turf lip at the island edge: what the top-down RTS camera actually sees.
    const radial = x.mul(x).add(z.mul(z)).sqrt();
    const rim = smoothstep(1.85, 2.15, radial).mul(float(1).sub(smoothstep(-0.05, 0.02, y)));
    const underside = max(float(1).sub(smoothstep(-0.55, -0.2, y)), rim);
    const pocket = sin(x.mul(2.4).add(z.mul(1.7)).add(y.mul(0.6)).add(phase)).mul(0.5).add(0.5);
    const fraction = this.reserve.x;
    const active = smoothstep(pocket.sub(0.12), pocket.add(0.12), fraction).mul(fraction.sqrt());
    const strength = fraction.sqrt().mul(0.3).add(active.mul(0.7));
    const spent = mix(base, rgb(UNIT_PAINT.iron), 0.6);
    const unknown = mix(base, rgb(PENCIL.sky), 0.48);
    const live = mix(rgb(ORE_HEAP_PAINT.rubble), rgb(ORE_HEAP_PAINT.crystal), strength.mul(0.85).add(0.15));
    const observed = mix(spent, live, strength);
    // Mineral ribs (PART.vein, fixed public geometry) carry the reserve at full strength where the cap cannot hide it.
    const rib = step(19.5, attribute<'float'>('part', 'float'));
    const veined = mix(base, mix(unknown, observed, this.reserve.y), max(seam.mul(underside), rib)) as V3;
    // Crisp branching cracks on the cliff band and turf edge, read from the RTS camera: a bright mineral core inside a
    // dark ink edge. Only a disclosed reserve draws them (crystal when rich, dull iron when spent); unknown draws none.
    const trunk = abs(sin(x.mul(3.1).add(z.mul(2.3)).add(sin(y.mul(5.3).add(x.mul(1.3))).mul(1.2)).add(phase)));
    const fork = abs(sin(z.mul(3.7).sub(x.mul(1.9)).add(sin(x.mul(4.1).sub(y.mul(2.7))).mul(0.9)).sub(phase)));
    const crack = min(trunk, fork.add(0.04));
    const band = rim.mul(float(1).sub(rib)).mul(this.reserve.y);
    const core = float(1).sub(smoothstep(0.07, 0.11, crack)).mul(band);
    const edge = float(1).sub(smoothstep(0.15, 0.2, crack)).mul(band);
    const bright = mix(rgb(UNIT_PAINT.iron), mix(rgb(ORE_HEAP_PAINT.crystal), rgb('#f4fffb'), 0.3), fraction.sqrt());
    const painted = mix(mix(veined, rgb(INK.sky), edge.mul(0.85)), bright, core) as V3;
    if (!storm) return painted;
    const stone = max(max(seam.mul(underside), rib), max(core, edge));
    return mix(painted, painted.mul(rgb(WET)), stone.mul(storm.x)) as V3;
  }

  /** Only authoritative view fields enter the knowledge state. Exhaustion is permanent for this island identity. */
  observe(e: Pick<Entity, 'oreCapacity' | 'oreRemaining'>): void {
    if (e.oreRemaining === 0) this.exhausted = true;
    const fraction = this.exhausted ? 0 : e.oreRemaining === undefined || !(e.oreCapacity && e.oreCapacity > 0)
      ? -1 : clamp(e.oreRemaining / e.oreCapacity, 0, 1);
    if (fraction === this.fraction) return;
    this.fraction = fraction;
    this.reserve.value.set(Math.max(0, fraction), fraction < 0 ? 0 : 1);
    let count = 0;
    const matrices = this.mesh.instanceMatrix.array;
    for (let i = 0; i < this.count; i++) {
      const fill = clamp(fraction * TIERS - this.tier[i]!, 0, 1);
      if (fill <= 0) continue;
      const scale = Math.cbrt(fill), from = i * 16, to = count++ * 16;
      for (let k = 0; k < 12; k++) matrices[to + k] = this.rest[from + k]! * scale;
      for (let k = 12; k < 16; k++) matrices[to + k] = this.rest[from + k]!;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    // The storm reveal borrows these actual instanced bounds, not the unit prism's geometry bounding box.
    this.mesh.computeBoundingBox();
    if (!count) this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose(); // instance storage only; the immutable geometry/material kit is shared by other islands
  }
}
