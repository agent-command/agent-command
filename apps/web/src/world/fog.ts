/**
 * Fog of war, owned by one world and shared by every map size. R = visible now, G = explored this match, B = the
 * cell's blend class: the soft fog edge blends a texel into a fragment only within one class, so visibility never
 * bleeds across a wall (DESIGN §7).
 */
import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType, type Node } from 'three/webgpu';
import { float, floor, mx_noise_vec3, positionWorld, texture, uniform, vec2 } from 'three/tsl';
import { gatesOpen, isOpenCell, isSurfaceHigh, MAX_MAP_SIZE, PLANES, SURFACE, unpackTerrain, VISION_BITS_PER_WORD, wallHit, type MatchData, type Plane, type View } from '@agent-command/game/contract';

/** Bits per vision word (word w bit i = cell w*30+i). */
const BITS = VISION_BITS_PER_WORD;
/** Texture side: every map size draws into the top-left `size`² texels of one fixed-capacity texture. */
const CAPACITY = MAX_MAP_SIZE;
/**
 * Blend classes (B channel). Cells blend their visibility softly only with cells of their own class; BRIDGE (a ruin
 * breach or open gate) joins the regions it opens onto. Depths: tunnel | rock (unknown counts as rock). Surface: low
 * ground | cliff | high ground. Orbit: outside | hull | corridor | ring | chamber. The Sky has no walls.
 */
const OPEN = 0;
const SOLID = 1;
const HIGH = 2;
const HULL = 1;
const CORRIDOR = 2;
const RING = 3;
const CHAMBER = 4;
const BRIDGE = 255;
interface FogPlane {
  tex: DataTexture;
  /** RGBA texels, row stride CAPACITY; row/column `size` repeat the map's last row/column so the blend never reads unused texels. */
  data: Uint8Array;
  /** eased (visible, explored) per map cell, row stride `size` */
  cur: Float32Array;
  target: Float32Array;
  /** blend class per map cell, row stride `size` */
  blend: Uint8Array;
  settled: boolean;
}
function make(): FogPlane {
  const data = new Uint8Array(CAPACITY * CAPACITY * 4).fill(255);
  const tex = new DataTexture(data, CAPACITY, CAPACITY, RGBAFormat, UnsignedByteType);
  // Texels are read whole: the shader blends them itself, class by class.
  tex.magFilter = tex.minFilter = NearestFilter;
  tex.needsUpdate = true;
  return { tex, data, cur: new Float32Array(0), target: new Float32Array(0), blend: new Uint8Array(0), settled: true };
}

/** Fog shading ease toward newly seen cells, per second: fast, so fresh vision reads at once (~0.3 s). */
export const FOG_REVEAL_RATE = 12;
/** Fog shading ease toward cells no longer seen, per second: slow, a soft trail behind moving units (~1–2 s). */
export const FOG_CONCEAL_RATE = 2.5;

/**
 * Side of the map on screen, in tiles. Shaders read the size from this uniform, never as a constant, so every map size
 * generates the same shader code and shares one compiled pipeline (a size change never recompiles). The World sets it
 * whenever it switches to a size's scene bundle; only one bundle is ever on screen.
 */
export const MAP_SIZE = uniform(0);
/** The fog edge's world-space wobble (~1 feature per tile, components in about −1..1): it breaks the bilinear fog's
 * smooth boundary into an irregular one. Shared with the storm cutaway edges, so they read as the same family. */
export const fogEdgeNoise = (p: Node<'vec3'>): Node<'vec3'> => mx_noise_vec3(p.mul(0.9)) as unknown as Node<'vec3'>;
/** Map coordinates (0..1) of the fragment's world position. */
export const mapUV = () => positionWorld.xz.div(MAP_SIZE).add(0.5) as unknown as Node<'vec2'>;

/**
 * Bilinear (visible, explored) at tile point `s` (the fragment `p` displaced by the edge wobble, under half a tile, so
 * the 2×2 block of texels round `s` holds `p`'s own cell). A texel counts only if it is that cell, or shares its blend
 * class (BRIDGE shares every class); a diagonal one also needs a cell of that class beside the shared corner, so no
 * blend slips through the joint of two walls touching at a corner. Where nothing counts, `p`'s own cell.
 */
function blendedFog(tex: DataTexture, p: Node<'vec2'>, s: Node<'vec2'>): Node<'vec2'> {
  const texel = (c: Node<'vec2'>) => texture(tex, c.add(0.5).div(CAPACITY));
  const own = floor(p);
  const home = texel(own);
  // Bytes read back normalised: a class compares exactly with itself, and BRIDGE reads as 1.
  const bridgeB = BRIDGE / 255;
  const bridge = home.b.equal(bridgeB);
  const q = s.sub(0.5);
  const base = floor(q);
  const f = q.sub(base);
  const at = own.sub(base);
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
  const t = corners.map(([i, j]) => texel(base.add(vec2(i, j))));
  const same = t.map((u) => u.b.equal(home.b).or(u.b.equal(bridgeB)).or(bridge));
  /** index of corner (i, j) in `corners` */
  const k = (i: number, j: number) => i + 2 * j;
  let sum = float(0) as unknown as Node<'float'>;
  let acc = vec2(0, 0) as unknown as Node<'vec2'>;
  for (const [i, j] of corners) {
    const isOwn = at.x.equal(i).and(at.y.equal(j));
    const diagonal = at.x.notEqual(i).and(at.y.notEqual(j));
    const ok = isOwn.or(same[k(i, j)]!.and(diagonal.not().or(same[k(1 - i, j)]!).or(same[k(i, 1 - j)]!)));
    const w = (i ? f.x : f.x.oneMinus()).mul(j ? f.y : f.y.oneMinus());
    const weight = ok.select(w, float(0));
    sum = sum.add(weight) as unknown as Node<'float'>;
    acc = acc.add(t[k(i, j)]!.rg.mul(weight)) as unknown as Node<'vec2'>;
  }
  return sum.greaterThan(1e-4).select(acc.div(sum), home.rg) as unknown as Node<'vec2'>;
}

/**
 * Fog of war of the map on screen. One instance serves every map size: its textures and shader nodes are created once
 * at capacity, so every material that reads fog is the same shader at any size and compiles once (`setSize` only
 * resizes the CPU-side state).
 */
export class FogField {
  size = 0;
  readonly planes: Record<Plane, FogPlane> = { depths: make(), surface: make(), sky: make(), orbit: make() };
  /** Decoded visibility for minimaps and picking, row stride `size`. */
  readonly visible = {} as Record<Plane, Uint8Array>;
  /** Monotonic exploration; all visible in the lobby. */
  readonly explored = {} as Record<Plane, Uint8Array>;
  /** Shared sampling nodes, so materials built for different sizes share one node graph (TextureNode keys by identity). */
  private readonly fogNodes = new Map<string, Node<'vec2'>>();
  private readonly visNodes = new Map<Plane, Node<'float'>>();
  /** The match and gate state the blend classes were last built for (ingestWalls). */
  private wallsMatch: MatchData | undefined;
  private wallsOpen: boolean | undefined;

  constructor(size: number) {
    this.setSize(size);
  }

  /** Switch to a map size: fresh, fully visible state (a size change is always a new match or preview). */
  setSize(size: number): void {
    if (size > CAPACITY) throw new Error(`Map size ${size} exceeds the fog capacity ${CAPACITY}`);
    this.size = size;
    const n = size * size;
    for (const p of PLANES) {
      const f = this.planes[p];
      f.cur = new Float32Array(n * 2).fill(1);
      f.target = new Float32Array(n * 2).fill(1);
      f.blend = new Uint8Array(n);
      f.data.fill(255);
      f.tex.needsUpdate = true;
      f.settled = true;
      this.visible[p] = new Uint8Array(n).fill(1);
      this.explored[p] = new Uint8Array(n).fill(1);
    }
    this.wallsMatch = undefined;
    this.wallsOpen = undefined;
  }

  /** Smoothed (visible, explored), with optional tile-scale edge noise; never blended across a wall. */
  fogAt(plane: Plane, wobble = 0.3): Node<'vec2'> {
    const key = `${plane}:${wobble}`;
    let node = this.fogNodes.get(key);
    if (!node) {
      const p = mapUV().mul(MAP_SIZE) as unknown as Node<'vec2'>;
      const s = wobble === 0 ? p : p.add(fogEdgeNoise(positionWorld).xz.mul(wobble)) as unknown as Node<'vec2'>;
      node = blendedFog(this.planes[plane].tex, p, s);
      this.fogNodes.set(key, node);
    }
    return node;
  }
  fogVis(plane: Plane): Node<'float'> {
    let node = this.visNodes.get(plane);
    if (!node) {
      node = this.fogAt(plane, 0).x as unknown as Node<'float'>;
      this.visNodes.set(plane, node);
    }
    return node;
  }
  tileVisible(plane: Plane, x: number, y: number): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    return xi >= 0 && yi >= 0 && xi < this.size && yi < this.size && this.visible[plane][yi * this.size + xi] === 1;
  }
  /**
   * Blend classes from what the team knows: the public Surface terrain, its Depths knowledge and the public ruin with
   * its gate state at the view's tick. Marks a plane for upload only when a class changed.
   */
  ingestWalls(view: View & { match: MatchData }): void {
    const size = this.size;
    const n = size * size;
    if (view.match !== this.wallsMatch) {
      this.wallsMatch = view.match;
      const terrain = unpackTerrain(view.match.terrain, size);
      const blend = this.planes.surface.blend;
      for (let c = 0; c < n; c++) blend[c] = terrain[c] === SURFACE.cliff ? SOLID : isSurfaceHigh(terrain[c]!) ? HIGH : OPEN;
      this.planes.surface.settled = false;
      this.wallsOpen = undefined;
    }
    const depths = this.planes.depths;
    for (let c = 0; c < n; c++) {
      const b = isOpenCell(view.depths[c] ?? 0) ? OPEN : SOLID;
      if (depths.blend[c] !== b) {
        depths.blend[c] = b;
        depths.settled = false;
      }
    }
    const g = view.match.derelict;
    const open = g ? gatesOpen(g, view.tick) : false;
    if (open === this.wallsOpen) return;
    this.wallsOpen = open;
    const orbit = this.planes.orbit;
    orbit.settled = false;
    if (!g) {
      orbit.blend.fill(0);
      return;
    }
    for (let c = 0; c < n; c++) {
      const dx = (c % size) + 0.5 - g.x;
      const dy = Math.floor(c / size) + 0.5 - g.y;
      const r2 = dx * dx + dy * dy;
      const hull = r2 >= g.hullInner * g.hullInner && r2 <= g.hullOuter * g.hullOuter;
      const ring = r2 >= g.ringInner * g.ringInner && r2 <= g.ringOuter * g.ringOuter;
      orbit.blend[c] = hull || ring ? (wallHit(g, open, dx, dy, 0) ? (hull ? HULL : RING) : BRIDGE)
        : r2 < g.ringInner * g.ringInner ? CHAMBER : r2 < g.hullInner * g.hullInner ? CORRIDOR : OPEN;
    }
  }
  ingestVision(view: View, fresh = false): void {
    const n = this.size * this.size;
    for (const p of PLANES) {
      const words = view.vision[p], f = this.planes[p], vis = this.visible[p], exp = this.explored[p];
      if (fresh) {
        exp.fill(0);
        for (let c = 0; c < n; c++) f.cur[c * 2 + 1] = 0;
      }
      for (let c = 0; c < n; c++) {
        const on = ((words[(c / BITS) | 0] ?? 0) >>> (c % BITS)) & 1;
        vis[c] = on;
        if (on) exp[c] = 1;
        f.target[c * 2] = on;
        f.target[c * 2 + 1] = exp[c]!;
      }
      f.settled = false;
    }
  }
  /**
   * Ease retained arrays in place; settled planes do no work. Display only and asymmetric: newly seen cells open fast
   * (FOG_REVEAL_RATE) and cells you stop seeing close slowly (FOG_CONCEAL_RATE), leaving a soft trail behind moving
   * units. Fog-safe: the trail is shading only; units in it are already gone (the server stops sending them).
   */
  stepFog(dt: number): void {
    const reveal = Math.min(1, dt * FOG_REVEAL_RATE);
    const conceal = Math.min(1, dt * FOG_CONCEAL_RATE);
    for (const p of PLANES) {
      const f = this.planes[p];
      if (f.settled) continue;
      let moving = false;
      const size = this.size;
      for (let c = 0; c < f.cur.length; c++) {
        const d = f.target[c]! - f.cur[c]!;
        if (d > 0.004) { f.cur[c] = f.cur[c]! + d * reveal; moving = true; }
        else if (d < -0.004) { f.cur[c] = f.cur[c]! + d * conceal; moving = true; }
        else f.cur[c] = f.target[c]!;
      }
      // Texels at stride CAPACITY, plus a repeated last column/row (the texel past the map edge).
      for (let y = 0; y <= size && y < CAPACITY; y++) {
        const sy = Math.min(y, size - 1);
        for (let x = 0; x <= size && x < CAPACITY; x++) {
          const cell = sy * size + Math.min(x, size - 1);
          const dst = (y * CAPACITY + x) * 4;
          f.data[dst] = (f.cur[cell * 2]! * 255) | 0;
          f.data[dst + 1] = (f.cur[cell * 2 + 1]! * 255) | 0;
          f.data[dst + 2] = f.blend[cell]!;
        }
      }
      f.tex.needsUpdate = true;
      f.settled = !moving;
    }
  }
  resetFog(): void {
    for (const p of PLANES) {
      this.planes[p].target.fill(1);
      this.planes[p].blend.fill(0);
      this.visible[p].fill(1);
      this.explored[p].fill(1);
      this.planes[p].settled = false;
    }
    this.wallsMatch = undefined;
    this.wallsOpen = undefined;
  }
}
