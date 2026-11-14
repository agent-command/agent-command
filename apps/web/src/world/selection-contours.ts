/** Padded selection contours, painted once over a local union of mobile-unit footprints.
 * CPU bins footprints, never unit pairs. The shader takes their minimum distance: overlaps have
 * one outer ink edge and one wash, without density-dependent swelling or a hull across empty ground.
 * Surface patches borrow the DRAWN FieldMesh positions and indices, including partial bake uploads.
 */
import { BufferAttribute, type BufferGeometry, type Color, DataTexture, DynamicDrawUsage, FloatType, InstancedBufferAttribute, InstancedBufferGeometry, IntType, Mesh, MeshBasicNodeMaterial, NearestFilter, RGBAFormat } from 'three/webgpu';
import { Fn, Loop, abs, attribute, color, float, int, ivec2, max, min, mix, positionGeometry, positionWorld, select, smoothstep, textureLoad, vec2, vec3 } from 'three/tsl';
import { ARMIES, PLANES, PLANE_Y, SURFACE, footprint, isNeutralKind, isSurfaceHigh, surfaceFeature, type Entity } from '@agent-command/game/contract';
import { commandOverlay, noise, seen, type F1 } from './materials.ts';
import { INK } from './palette.ts';
import type { FogField } from './fog.ts';
import type { TerrainField } from './terrain.ts';

const TILE = 2;
const WIDTH = 1024;
/** At maximum existing mobile scale, 1.75 * (.6 * 1.35 * 1.35 * 2.2) < 4.22 tiles.
 * A diameter < 8.44 touches at most six 2-tile bins per axis. No selected source is truncated. */
const COPIES = 36;
const SUPPORT = 1.75;
const PAD = 1.65;
const ENTER_SECONDS = 0.15;

export function contourEligible(e: Entity, selected: ReadonlySet<string>, visible: boolean): boolean {
  return visible && selected.has(e.id) && e.hp > 0 && !e.cloaked && e.side !== 'neutral'
    && !isNeutralKind(e.kind) && !footprint(e.kind) && e.kind !== 'spire'
    && e.state !== 'falling' && e.state !== 'hangared' && e.state !== 'launching';
}

/** No army/plane union; quarter-tile deck bands cannot join moored aircraft to overhead traffic. */
export function contourLayer(e: Pick<Entity, 'side' | 'plane'>, elevation: number, high: boolean): number {
  return (ARMIES.indexOf(e.side as typeof ARMIES[number]) * 4096 * 4 + PLANES.indexOf(e.plane) * 4096)
    + (e.plane === 'surface' ? Number(high) : Math.round(elevation * 4) + 2048);
}

interface DrawnTerrain {
  position: BufferAttribute;
  index: BufferAttribute;
}

/** Copy the actual draw, not field.h: a worker may have adopted a new bake while FieldMesh still
 * uploads row bands. W records the drawn diagonal; G adds only real bridge/ford support to drawn Y. */
export function writeContourSupport(out: Float32Array, offset: number, terrain: TerrainField, drawn: DrawnTerrain, ix: number, iz: number): void {
  const res = samplesPerTile(terrain);
  const x = ix / res, z = iz / res;
  const cell = Math.min(terrain.size - 1, Math.floor(z)) * terrain.size + Math.min(terrain.size - 1, Math.floor(x));
  const code = terrain.terrainCodes[cell] ?? 0;
  const n = terrain.field.n;
  const height = drawn.position.getY(iz * n + ix);
  out[offset] = height;
  out[offset + 1] = terrain.groundAt(x, z, height);
  out[offset + 2] = surfaceFeature(code) === SURFACE.cliff || terrain.holeAt.has(cell) ? 2 : Number(isSurfaceHigh(code));
  out[offset + 3] = Number(ix < n - 1 && iz < n - 1 && drawn.index.getX((iz * (n - 1) + ix) * 6 + 2) === (iz + 1) * n + ix + 1);
}

/** Height samples per map tile, from the drawn field itself rather than a duplicated constant. */
function samplesPerTile(terrain: TerrainField): number {
  return (terrain.field.n - 1) / terrain.size;
}

/** Selection ease is independent of source position: moving units never trail their contour. */
export function selectionEntrance(previous: number, dt: number, reducedMotion: boolean): number {
  return reducedMotion ? 1 : Math.min(1, previous + Math.max(0, dt) / ENTER_SECONDS);
}

export class SelectionContours {
  readonly mesh: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>;
  private capacity = 0;
  private tiles = 0;
  private links = 0;
  private epoch = 0;
  private dt = 0;
  private reducedMotion = false;
  private hash = new Int32Array(0);
  /** hash slot claimed by each tile this frame, so begin() clears only those, not the whole table. */
  private slots = new Int32Array(0);
  /** Records actually uploaded: unchanged selections skip the record texture upload. */
  private published = 0;
  private recordsDirty = false;
  /** Drawn-terrain upload stamp each 2-tile bin's support samples were copied at; ground uploads only on change. */
  private readonly groundStamp: Float64Array;
  private groundDirty = false;
  private keys = new Float64Array(0);
  private heads = new Int32Array(0);
  private counts = new Int32Array(0);
  private next = new Int32Array(0);
  private sources = new Float32Array(0);
  private data = new Float32Array(0);
  private records: DataTexture;
  private readonly recordNode;
  private tile!: InstancedBufferAttribute;
  private tint!: InstancedBufferAttribute;
  private support!: InstancedBufferAttribute;
  private readonly heights: Float32Array;
  private readonly ground: DataTexture;
  private readonly grid: number;
  private readonly heightSide: number;
  private readonly res: number;
  private readonly terrain: TerrainField;
  private drawn?: DrawnTerrain;
  private readonly entering = new Map<string, { epoch: number; amount: number }>();
  private readonly decks = new Map<number, { epoch: number; sum: number; count: number }>();

  constructor(terrain: TerrainField, fog?: FogField) {
    this.terrain = terrain;
    this.grid = Math.ceil(terrain.size / TILE);
    this.heightSide = terrain.field.n;
    this.res = samplesPerTile(terrain);
    this.groundStamp = new Float64Array(this.grid * this.grid).fill(-1);
    this.heights = new Float32Array(this.heightSide ** 2 * 4);
    this.ground = new DataTexture(this.heights, this.heightSide, this.heightSide, RGBAFormat, FloatType);
    this.ground.minFilter = this.ground.magFilter = NearestFilter;
    this.records = new DataTexture(new Float32Array(WIDTH * 4), WIDTH, 1, RGBAFormat, FloatType);
    this.recordNode = textureLoad(this.records, ivec2(0));

    // Both corner layouts use the actual draw's index buffer, including partially uploaded bakes.
    const RES = this.res;
    const cells = TILE * RES;
    const positions = new Float32Array(cells * cells * 6 * 3);
    const corners = new Float32Array(cells * cells * 6 * 4);
    const diagonalAD = [0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0];
    const diagonalBC = [0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1];
    let v = 0;
    for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) for (let c = 0; c < 6; c++, v++) {
      positions[v * 3] = x; positions[v * 3 + 2] = z;
      corners[v * 4] = diagonalAD[c * 2]!; corners[v * 4 + 1] = diagonalAD[c * 2 + 1]!;
      corners[v * 4 + 2] = diagonalBC[c * 2]!; corners[v * 4 + 3] = diagonalBC[c * 2 + 1]!;
    }
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('contourCorner', new BufferAttribute(corners, 4));
    // Coplanar decal: commandOverlay's slope-scaled depth slack keeps it on its ground, where a world-space lift would
    // intersect on slopes/zoom.
    const mat = commandOverlay(new MeshBasicNodeMaterial());
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = 'selected-toon-contours';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 39;
    this.reserve(1024);
    // Record addresses/counts are integers, NOT smoothly interpolated floats: perspective
    // interpolation can undershoot an integer, changing int() lookups and exposing ground speckles.
    const tile = attribute<'uvec4'>('contourTile', 'uvec4').toVarying('v_contourTile').setInterpolation('flat');
    const tint = attribute<'vec4'>('contourTint', 'vec4').toVarying('v_contourTint').setInterpolation('flat');
    const support = attribute<'vec4'>('contourSupport', 'vec4').toVarying('v_contourSupport').setInterpolation('flat');
    const cornersNode = attribute<'vec4'>('contourCorner', 'vec4');
    const sample = vec2(tile.xy).mul(RES).add(positionGeometry.xz);
    const a = textureLoad(this.ground, ivec2(sample));
    const b = textureLoad(this.ground, ivec2(sample.add(vec2(1, 0))));
    const c = textureLoad(this.ground, ivec2(sample.add(vec2(0, 1))));
    const d = textureLoad(this.ground, ivec2(sample.add(1)));
    const corner = select(a.a.greaterThan(0.5), cornersNode.xy, cornersNode.zw);
    const p = sample.add(corner).div(RES);
    const height = mix(mix(a.g, b.g, corner.x), mix(c.g, d.g, corner.x), corner.y);
    mat.positionNode = vec3(p.x.sub(terrain.size / 2), mix(support.x, height.add(PLANE_Y.surface), support.y), p.y.sub(terrain.size / 2));

    // The closest padded footprint defines ONE exterior. Unlike summed potentials, a dense
    // crowd cannot inflate its coverage or opacity; unlike a hull, empty gaps stay empty.
    const contour = Fn(() => {
      const nearest = float(1e6).toVar();
      const paint = float(0).toVar();
      Loop({ start: int(0), end: int(tile.w), type: 'int', condition: '<' }, ({ i }) => {
        const index = int(tile.z).add(i);
        const shape = this.recordNode.load(ivec2(index.mod(WIDTH), index.div(WIDTH)));
        const distance = positionWorld.xz.add(terrain.size / 2).sub(shape.xy).length().div(shape.z);
        nearest.assign(min(nearest, distance));
        paint.assign(max(paint, float(1).sub(smoothstep(0.92, 1.04, distance)).mul(shape.w)));
      });
      return vec3(nearest, paint, 0);
    })();
    const edge = contour.x.add(noise(positionWorld.xz.mul(0.85)).r.sub(0.5).mul(0.055));
    const body = float(1).sub(smoothstep(0.70, 0.91, edge));
    const pool = smoothstep(0.56, 0.83, edge).mul(body);
    const rim = float(1).sub(smoothstep(0.014, 0.045, abs(edge.sub(0.865))));
    const region = textureLoad(this.ground, ivec2(positionWorld.xz.add(terrain.size / 2).mul(RES).floor())).b;
    const sameGround = float(1).sub(abs(region.sub(support.w))).max(0);
    let visibility: F1 = float(0);
    for (let i = 0; i < PLANES.length; i++) visibility = visibility.add(seen(PLANES[i]!, fog).mul(float(1).sub(abs(support.z.sub(i))).max(0)));
    mat.colorNode = mix(tint.xyz.mul(float(1).sub(pool.mul(0.3))), color(INK.surface), rim.mul(0.6));
    mat.opacityNode = max(body.mul(0.42).add(pool.mul(0.3)), rim.mul(0.45)).mul(tint.w).mul(contour.y).mul(visibility).mul(mix(1, sameGround, support.y));
  }

  /** Borrowed buffers remain authoritative through FieldMesh's in-place band uploads. */
  bindTerrain(geometry: BufferGeometry): void {
    this.drawn = { position: geometry.getAttribute('position') as BufferAttribute, index: geometry.index! };
    this.groundStamp.fill(-1);
  }

  /** Changes only when FieldMesh flags a (full or band) upload of the borrowed buffers. */
  private terrainStamp(): number {
    return this.drawn ? this.drawn.position.version * 2 ** 26 + this.drawn.index.version : 0;
  }

  /** Snapshot boundary only. Grows for every visible entity, not a capped selection subset. */
  reserve(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = 2 ** Math.ceil(Math.log2(Math.max(n, 1024)));
    const count = this.capacity * COPIES;
    this.hash = new Int32Array(2 ** Math.ceil(Math.log2(count * 2))).fill(-1);
    this.slots = new Int32Array(count);
    this.keys = new Float64Array(count);
    this.heads = new Int32Array(count);
    this.counts = new Int32Array(count);
    this.next = new Int32Array(count);
    this.sources = new Float32Array(count * 4);
    this.data = new Float32Array(count * 4);
    const previous = this.records;
    this.records = new DataTexture(this.data, WIDTH, count / WIDTH, RGBAFormat, FloatType);
    this.records.minFilter = this.records.magFilter = NearestFilter;
    this.recordNode.value = this.records;
    this.published = 0;
    this.recordsDirty = true;
    previous.dispose();
    if (this.tile) {
      this.tile.dispose(); this.tint.dispose(); this.support.dispose();
      this.mesh.geometry.dispose();
      this.mesh.material.needsUpdate = true;
    }
    this.tile = new InstancedBufferAttribute(new Uint32Array(count * 4), 4).setUsage(DynamicDrawUsage);
    this.tile.gpuType = IntType;
    this.tint = new InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(DynamicDrawUsage);
    this.support = new InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(DynamicDrawUsage);
    this.mesh.geometry.setAttribute('contourTile', this.tile);
    this.mesh.geometry.setAttribute('contourTint', this.tint);
    this.mesh.geometry.setAttribute('contourSupport', this.support);
    // More visible units are not a new selection: preserve existing entrance progress across growth.
    this.begin(0, true);
  }

  reset(): void {
    this.entering.clear(); this.decks.clear();
    this.begin(0, true);
  }

  begin(dt: number, reducedMotion: boolean): void {
    this.epoch++;
    this.dt = dt;
    this.reducedMotion = reducedMotion;
    for (let i = 0; i < this.tiles; i++) this.hash[this.slots[i]!] = -1;
    this.tiles = this.links = 0;
    this.mesh.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  /** Returns the complementary normal-dab fade. Position is always the current interpolated position. */
  add(e: Entity, x: number, z: number, y: number, radius: number, elevation: number, tint: Color, alpha: number): number {
    // Standalone unit previews have no drawn terrain; retain their ordinary dab instead.
    if (e.plane === 'surface' && !this.drawn) return 1;
    let entry = this.entering.get(e.id);
    if (!entry) { entry = { epoch: this.epoch, amount: 0 }; this.entering.set(e.id, entry); }
    entry.epoch = this.epoch;
    entry.amount = selectionEntrance(entry.amount, this.dt, this.reducedMotion);
    const amount = entry.amount * entry.amount * (3 - 2 * entry.amount);
    const padded = radius * (1 + (PAD - 1) * amount);
    const reach = radius * SUPPORT;
    const high = isSurfaceHigh(this.terrain.terrainCodes[Math.floor(z) * this.terrain.size + Math.floor(x)] ?? 0);
    const layer = contourLayer(e, elevation, high);
    let deck = this.decks.get(layer);
    if (!deck) { deck = { epoch: this.epoch, sum: 0, count: 0 }; this.decks.set(layer, deck); }
    if (deck.epoch !== this.epoch) { deck.epoch = this.epoch; deck.sum = deck.count = 0; }
    deck.sum += y; deck.count++;
    const stamp = this.terrainStamp();
    const x0 = Math.max(0, Math.floor((x - reach) / TILE)), x1 = Math.min(this.grid - 1, Math.floor((x + reach) / TILE));
    const z0 = Math.max(0, Math.floor((z - reach) / TILE)), z1 = Math.min(this.grid - 1, Math.floor((z + reach) / TILE));
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) {
      const key = (layer * this.grid + tz) * this.grid + tx;
      let slot = Math.imul(key | 0, 2654435761) & (this.hash.length - 1);
      while (this.hash[slot] !== -1 && this.keys[this.hash[slot]!] !== key) slot = (slot + 1) & (this.hash.length - 1);
      let tile = this.hash[slot]!;
      if (tile === -1) {
        // reserve() sizes every table for COPIES bins per visible unit; never write past them.
        if (this.tiles >= this.keys.length || this.links >= this.next.length) continue;
        tile = this.tiles++;
        this.hash[slot] = tile; this.keys[tile] = key; this.slots[tile] = slot;
        this.heads[tile] = -1; this.counts[tile] = 0;
        this.tile.setXYZW(tile, tx * TILE, tz * TILE, 0, 0);
        this.tint.setXYZW(tile, tint.r, tint.g, tint.b, alpha);
        this.support.setXYZW(tile, y, Number(e.plane === 'surface'), PLANES.indexOf(e.plane), Number(high));
        const bin = tz * this.grid + tx;
        if (e.plane === 'surface' && this.groundStamp[bin] !== stamp) {
          this.groundStamp[bin] = stamp;
          this.groundDirty = true;
          const span = TILE * this.res;
          for (let dz = 0; dz <= span; dz++) for (let dx = 0; dx <= span; dx++) {
            const hx = tx * span + dx, hz = tz * span + dz;
            if (hx < this.heightSide && hz < this.heightSide) writeContourSupport(this.heights, (hz * this.heightSide + hx) * 4, this.terrain, this.drawn!, hx, hz);
          }
        }
      }
      if (this.links >= this.next.length) continue;
      const j = this.links++, off = j * 4;
      this.sources[off] = x; this.sources[off + 1] = z; this.sources[off + 2] = padded; this.sources[off + 3] = amount;
      this.next[j] = this.heads[tile]!; this.heads[tile] = j; this.counts[tile] = this.counts[tile]! + 1;
    }
    return 1 - amount;
  }

  publish(): void {
    let offset = 0;
    for (let i = 0; i < this.tiles; i++) {
      this.tile.setZ(i, offset); this.tile.setW(i, this.counts[i]!);
      const layer = Math.floor(this.keys[i]! / (this.grid * this.grid));
      const deck = this.decks.get(layer)!;
      // Every tile of a deck gets the same current height: no first-contributor or tile-border steps.
      this.support.setX(i, deck.sum / deck.count);
      // Walk exactly counts[i] links: a corrupt or truncated chain cannot spin forever.
      for (let n = this.counts[i]!, j = this.heads[i]!; n > 0 && j !== -1; n--, j = this.next[j]!) {
        const from = j * 4, to = offset++ * 4;
        for (let k = 0; k < 4; k++) {
          const value = this.sources[from + k]!;
          if (this.data[to + k] !== value) { this.data[to + k] = value; this.recordsDirty = true; }
        }
      }
    }
    // Hidden/dead/deselected sources leave neither a rendered record nor a remembered entrance state.
    for (const id of this.entering.keys()) if (this.entering.get(id)!.epoch !== this.epoch) this.entering.delete(id);
    for (const layer of this.decks.keys()) if (this.decks.get(layer)!.epoch !== this.epoch) this.decks.delete(layer);
    this.mesh.geometry.instanceCount = this.tiles;
    this.mesh.visible = this.tiles > 0;
    if (!this.tiles) return;
    this.tile.clearUpdateRanges(); this.tint.clearUpdateRanges(); this.support.clearUpdateRanges();
    this.tile.addUpdateRange(0, this.tiles * 4);
    this.tint.addUpdateRange(0, this.tiles * 4);
    this.support.addUpdateRange(0, this.tiles * 4);
    this.tile.needsUpdate = this.tint.needsUpdate = this.support.needsUpdate = true;
    // Textures have no partial upload path in this three; upload whole only when a record or support sample changed.
    if (offset !== this.published) { this.published = offset; this.recordsDirty = true; }
    if (this.recordsDirty) { this.records.needsUpdate = true; this.recordsDirty = false; }
    if (this.groundDirty) { this.ground.needsUpdate = true; this.groundDirty = false; }
  }

  dispose(): void {
    this.reset(); this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.records.dispose(); this.ground.dispose();
  }
}
