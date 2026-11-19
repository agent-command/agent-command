/**
 * Telegraphed terrain events (pillar 3: every threat is announced before it lands):
 * - the amber **stamp** (docs/art/DIRECTIONS.md §1): ring with an ink rim, 12 ink ticks, a *hatched* countdown pie and
 *   one ink glyph per kind (breach dig ⌃⌃, asteroid impact ✳), pulsing faster with a reticle sweep in the last 2 s. A
 *   planted charge's Surface stamp is a faint dashed danger ring on the collapse edge around a dynamite glyph (over a
 *   zigzag on a fault), brought to full strength with a pulsing halo in its public window; in the Depths the charge
 *   itself is drawn (`charges.ts`). Stamps are public information: never fogged, still shown (fainter) on ghosted
 *   planes. The hatch is the threat cue, so threat never depends on amber versus red (colour-blind safe);
 * - breach digs: the ground above cracks in ink while troopers dig up (enemy ones from `view.tremors` flagged
 *   `breach`, our own from troopers `breaching`), then the portal pops (`breakout` fx);
 * - chasms: cracks race along the fault from the charge outward, the ground slabs drop into the trench and rubble
 *   rains into the Depths, with a rolling rumble (`chasm` fx, one per opened cell);
 * - rails being laid, chasm cells bridged, magma flooding and cooling, embers rising off live lava;
 * - the Mother Lode: a countdown stamp over its chamber while its fuse burns, then the eruption (a white flash, a
 *   fountain of fire, a spray of embers and rock, a shockwave and a rolling rumble) as the ring floods outward.
 * Pooled and instanced; per-frame work allocates nothing.
 */
import { BoxGeometry, CircleGeometry, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, PlaneGeometry, type Node } from 'three/webgpu';
import { abs, atan, color, dot, float, fract, fwidth, instancedDynamicBufferAttribute, max, min, mix, mx_noise_float, positionWorld, sin, smoothstep, time, uv, vec2, vec3 } from 'three/tsl';
import { CELL, ECON, MOTHER_LODE_MAX_CELLS, PLANE_Y, TICK_RATE, VISION_BITS_PER_WORD, type ArmyId, type Plane, type View } from '@agent-command/game/contract';
import { fadeValue, focusValue } from './fade.ts';
import { THREAT_COLOR, clamp, hash2, relation, sideColor, wx as worldX, wz as worldZ } from './common.ts';
import { EFFECT_VISUALS, RING, type Combat } from './combat.ts';
import { inkMaterial, lines, overlay, type F1, type V3 } from './materials.ts';
import { CHARGE_PAINT, INK } from './palette.ts';
import { TerrainField, groundAt, type Fault } from './terrain.ts';
import { ChargeModels, chargeElapsed, chargeHeat, chargeLeft } from './charges.ts';

type V4 = Node<'vec4'>;
/** Breach dig time (s): the crack grows to full size over it. */
const BREACH_S = 6;
/** Delay (ms) between neighbouring cells as a chasm races along its fault. */
const RACE_MS = 120;
const SLAB_CAP = 96;
const CRACK_CAP = 48;
const STAMP_CAP = 192;
/** Glyph drawn at a stamp's centre, one per telegraph kind (a planted charge: a dynamite bundle, over a zigzag on a fault). */
const GLYPH = { tnt: 0, tntChasm: 1, breach: 2, impact: 3 } as const;
/** Charge telegraphs on the Surface stay faint (this share of full strength) until the charge's public window. */
const CHARGE_FAINT = 0.5;
/** The stamp's ring band sits at this share of its radius (`stampMaterial`): a charge stamp puts it on the collapse edge. */
const STAMP_RING = 0.84;
/** Embers rising off live lava: per cell and second, over at most EMBER_CELLS cells at once (a wide flood stays calm). */
const EMBER_RATE = 0.35;
const EMBER_CELLS = 40;
/** Depths stamps float just over the section cut (rock 1.25, bedrock 1.45), above the tunnel walls that would hide them. */
const DEPTHS_TOP = 1.52;

const COL = {
  dust: new Color('#b8996e'),
  rubble: new Color('#4a4038'),
  hot: new Color('#ec5a24'),
  white: new Color('#fff8e8'),
  portal: new Color('#9a68e8'),
  gold: new Color('#e0a81e'),
  steam: new Color('#c9c4bc'),
  ember: new Color('#d4401a'),
  steel: new Color('#bfe6ff'),
  /** emissive core (> 1: blooms) */
  flash: new Color(2.4, 1.9, 1.3),
};

/** The Depths layer's live lava (DepthsLayer): the cells embers rise from, and which of them are public. */
export interface LavaSource {
  readonly lavaCells: Int32Array;
  readonly lavaPublic: Uint8Array;
  readonly lavaCount: number;
}

interface Dig {
  since: number;
  seen: boolean;
  ours: boolean;
  /** 0..1 when known (own troopers report progress) */
  progress: number;
  nextPuff: number;
}

export class Telegraphs {
  readonly root = new Group();
  private readonly combat: Combat;
  private readonly cracks: InstancedMesh;
  private readonly crackTint: InstancedBufferAttribute;
  private readonly stamps: InstancedMesh;
  private readonly stampTint: InstancedBufferAttribute;
  /** per stamp: elapsed 0..1, glyph, seconds left, - */
  private readonly stampData: InstancedBufferAttribute;
  private charges: View['charges'] = [];
  /** Planted charges as models in the Depths (they own its countdown there). */
  readonly chargeModels: ChargeModels;
  /** rules.depths.collapseRadius (tiles): the charge stamp's ring. */
  private collapseRadius: number = ECON.collapseRadius;
  private impacts: View['impacts'] = [];
  private readonly impactRadii = new Map<string, number>();
  /** on-screen time (ms) of server tick `viewTick` and ms per tick, from the `at` mapping of the last view */
  private viewTick = 0;
  private viewMs = 0;
  private msPerTick = 1000 / TICK_RATE;
  private readonly slabs: InstancedMesh;
  // slab pool (struct of arrays): cell centre, start of the drop (ms), spin direction
  private readonly sx = new Float32Array(SLAB_CAP);
  private readonly sz = new Float32Array(SLAB_CAP);
  private readonly st = new Float64Array(SLAB_CAP);
  private readonly sr = new Float32Array(SLAB_CAP);
  private ns = 0;
  /** Scheduled bursts (rubble, dust) for cells that open later in a race: [ms, x, y] triples. */
  private readonly queue: number[] = [];
  private readonly digs = new Map<number, Dig>();
  private faults: readonly Fault[] = [];
  private lastTick = -1;
  private rumbleUntil = 0;
  private rumbleK = 0;
  focus: Plane = 'surface';
  private readonly lava: LavaSource | undefined;
  /** Lava cells embers rise from (public ones and those we see now), refreshed per view. */
  private readonly embers: Int32Array;
  private nEmbers = 0;
  private emberDue = 0;
  private emberSeq = 0;
  private lastFrame = 0;
  /** The Mother Lode's fuse (its public vent tick, 0: none) and one countdown stamp per known lode cluster: x, z, radius (world). */
  private ventAt = 0;
  private fuseS = 1;
  private readonly lodeStamps = new Float32Array(MOTHER_LODE_MAX_CELLS * 3);
  private nLodeStamps = 0;

  readonly size: number;
  private readonly terrain: TerrainField;

  constructor(combat: Combat, size: number, terrain = new TerrainField(size), lava?: LavaSource) {
    this.size = size;
    this.terrain = terrain;
    this.combat = combat;
    this.lava = lava;
    this.embers = new Int32Array(size * size);
    this.root.renderOrder = 36; // groupOrder: with the awareness decals, before entities

    this.crackTint = new InstancedBufferAttribute(new Float32Array(CRACK_CAP * 4), 4);
    this.crackTint.setUsage(DynamicDrawUsage);
    const t = instancedDynamicBufferAttribute<'vec4'>(this.crackTint, 'vec4') as V4;
    const p = uv().sub(0.5);
    const r = p.length().mul(2);
    const a = atan(p.y, p.x);
    const wobble = mx_noise_float(vec3(r.mul(6), a.mul(2.5), 0)).mul(0.7);
    // t.w = growth 0..1: more and longer cracks as the dig nears the surface
    const reach = t.w.mul(0.85).add(0.15);
    const crack = smoothstep(0.92, 0.995, abs(sin(a.mul(7).add(wobble).add(r.mul(2))))).mul(float(1).sub(smoothstep(reach.mul(0.8), reach, r)));
    const heave = smoothstep(reach, 0, r).mul(0.25);
    const shiver = sin(time.mul(t.w.mul(20).add(6))).mul(0.3).add(0.7);
    // charred ink cracks; the colour (own team / threat amber) is carried by the stamp on top
    const m = overlay(new MeshBasicNodeMaterial());
    m.colorNode = color(INK.surface);
    m.opacityNode = crack.mul(0.9).add(heave.mul(t.w).mul(0.35)).mul(shiver).min(1);
    this.cracks = new InstancedMesh(new CircleGeometry(1, 32).rotateX(-Math.PI / 2), m, CRACK_CAP);
    this.cracks.instanceMatrix.setUsage(DynamicDrawUsage);
    this.cracks.count = 0;
    this.cracks.frustumCulled = false;

    const slabMat = inkMaterial('surface', color('#a9978a') as unknown as V3, { fog: false });
    this.slabs = new InstancedMesh(new BoxGeometry(0.96, 0.7, 0.96).translate(0, -0.35, 0), slabMat, SLAB_CAP);
    this.slabs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.slabs.count = 0;
    this.slabs.frustumCulled = false;

    this.stampTint = new InstancedBufferAttribute(new Float32Array(STAMP_CAP * 4), 4);
    this.stampTint.setUsage(DynamicDrawUsage);
    this.stampData = new InstancedBufferAttribute(new Float32Array(STAMP_CAP * 4), 4);
    this.stampData.setUsage(DynamicDrawUsage);
    this.stamps = new InstancedMesh(new PlaneGeometry(2, 2).rotateX(-Math.PI / 2), stampMaterial(this.stampTint, this.stampData), STAMP_CAP);
    this.stamps.instanceMatrix.setUsage(DynamicDrawUsage);
    this.stamps.count = 0;
    this.stamps.frustumCulled = false;
    this.stamps.renderOrder = 2;
    this.chargeModels = new ChargeModels(size);
    this.root.add(this.cracks, this.slabs, this.stamps, this.chargeModels.root);
  }

  setFaults(faults: readonly Fault[]): void {
    this.faults = faults;
  }

  reset(): void {
    this.lastTick = -1;
    this.ns = 0;
    this.queue.length = 0;
    this.digs.clear();
    this.charges = [];
    this.impacts = [];
    this.impactRadii.clear();
    this.rumbleUntil = 0;
    this.nEmbers = 0;
    this.ventAt = 0;
    this.nLodeStamps = 0;
    this.chargeModels.reset();
  }

  /** `at(tick)`: server tick → performance.now() ms when it is rendered. */
  ingest(view: View, at: (tick: number) => number, now: number): void {
    this.trackDigs(view, now);
    this.charges = view.charges;
    this.impacts = view.impacts;
    this.impactRadii.clear();
    const orbit = view.match!.rules.orbit;
    for (const impact of view.impacts) {
      const rock = view.entities.find(e => e.id === impact.id);
      this.impactRadii.set(impact.id, (impact.radius ?? orbit.impactRadius) * (rock?.volatile === true ? orbit.volatileRadiusMultiplier : 1));
    }
    this.viewTick = view.tick;
    this.viewMs = at(view.tick);
    this.msPerTick = Math.max(1, at(view.tick + 1) - this.viewMs);
    this.collapseRadius = view.match!.rules.depths.collapseRadius;
    this.chargeModels.ingest(view, this.viewMs, this.msPerTick);
    const first = this.lastTick < 0;
    let max = this.lastTick;
    let chasm: { x: number; y: number }[] | undefined;
    let chasmTick = 0;
    for (const f of view.fx) {
      if (f.tick <= this.lastTick) continue;
      if (f.tick > max) max = f.tick;
      if (first && f.tick < view.tick - 2) continue;
      const t0 = at(f.tick);
      switch (f.kind) {
        case 'chasm':
          (chasm ??= []).push({ x: Math.floor(f.x), y: Math.floor(f.y) });
          chasmTick = f.tick;
          break;
        case 'breakout':
          this.breakout(f.x, f.y, t0);
          break;
        case 'bridge':
          this.bridge(f.x, f.y, t0);
          break;
        case 'rail':
          this.rail(f.x, f.y);
          break;
        case 'magma':
          this.magma(f.x, f.y, t0);
          break;
        case 'cool':
          this.cool(f.x, f.y);
          break;
        case 'cache_burned':
          this.cacheBurned(f.x, f.y, t0);
          break;
        case 'lode_vent':
          this.eruption(f.x, f.y, t0);
          break;
      }
    }
    if (chasm) this.openChasm(chasm, at(chasmTick));
    this.lastTick = Math.max(max, view.tick - 10);
    this.trackLava(view);
    this.trackFuse(view);
  }

  /** Embers rise from live lava that is public (the Mother Lode's ring) or that we see now. */
  private trackLava(view: View): void {
    this.nEmbers = 0;
    const lava = this.lava;
    if (!lava) return;
    const bits = view.vision.depths;
    for (let i = 0; i < lava.lavaCount; i++) {
      const c = lava.lavaCells[i]!;
      if (lava.lavaPublic[i] || ((bits[Math.floor(c / VISION_BITS_PER_WORD)] ?? 0) >>> (c % VISION_BITS_PER_WORD)) & 1) this.embers[this.nEmbers++] = c;
    }
  }

  /**
   * While the Mother Lode's fuse burns (public `motherLode.ventAt`): one countdown stamp per cluster of lode cells we
   * know, centred on it and as wide as the blast (the ring plus rules.depths.lodeVentBlastReach).
   */
  private trackFuse(view: View): void {
    const vent = view.motherLode?.ventAt;
    const rules = view.match?.rules;
    if (vent === undefined || !rules) {
      this.ventAt = 0;
      this.nLodeStamps = 0;
      return;
    }
    this.fuseS = Math.max(1 / TICK_RATE, rules.depths.lodeFuse);
    if (this.ventAt === vent) return;
    this.ventAt = vent;
    const size = this.size;
    // to the outer edge of the blast's last cells (half a cell beyond their centres)
    const reach = rules.map.motherLode.ringWidth + rules.depths.lodeVentBlastReach + 0.5;
    const cells: number[] = [];
    for (let c = 0; c < view.depths.length; c++) if (view.depths[c] === CELL.lode) cells.push(c);
    const done = new Uint8Array(cells.length);
    this.nLodeStamps = 0;
    for (let i = 0; i < cells.length && this.nLodeStamps < MOTHER_LODE_MAX_CELLS; i++) {
      if (done[i]) continue;
      // the cluster of lode cells touching this one (8-connected)
      const group = [i];
      done[i] = 1;
      for (let g = 0; g < group.length; g++) {
        const a = cells[group[g]!]!;
        for (let j = 0; j < cells.length; j++) {
          const b = cells[j]!;
          if (done[j] || Math.max(Math.abs((a % size) - (b % size)), Math.abs(Math.floor(a / size) - Math.floor(b / size))) > 1) continue;
          done[j] = 1;
          group.push(j);
        }
      }
      let cx = 0;
      let cy = 0;
      for (const k of group) {
        cx += (cells[k]! % size) + 0.5;
        cy += Math.floor(cells[k]! / size) + 0.5;
      }
      cx /= group.length;
      cy /= group.length;
      let r = 0;
      for (const k of group) r = Math.max(r, Math.hypot((cells[k]! % size) + 0.5 - cx, Math.floor(cells[k]! / size) + 0.5 - cy));
      const o = this.nLodeStamps++ * 3;
      this.lodeStamps[o] = worldX(cx, size);
      this.lodeStamps[o + 1] = worldZ(cy, size);
      this.lodeStamps[o + 2] = r + reach;
    }
  }

  /**
   * The Mother Lode erupts at lode cell (x, y): a white flash and shockwave, a fountain of fire, a spray of embers and
   * rock, a smoke plume and a rolling rumble, while the ring floods outward (DepthsLayer).
   */
  private eruption(x: number, y: number, t0: number): void {
    const c = this.combat;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    const dy = PLANE_Y.depths + 0.4;
    const seed = Math.round(x * 13 + y * 7);
    c.sparks.spawn(0, wx, dy + 0.4, wz, 0, 0, 0, 0.45, 1.2, 3.4, COL.flash, 1);
    c.sparks.spawn(0, wx, dy + 0.2, wz, 0, 1.4, 0, 1.1, 1.2, 2.6, COL.hot, 0.95);
    c.rings.add(0, wx, dy, wz, 0.3, 5.5, t0, 1000, COL.hot, 0.95, RING.wash);
    c.rings.add(0, wx, dy + 0.1, wz, 0.2, 3.6, t0 + 120, 800, COL.white, 0.8);
    // the fountain: big hot gobbets thrown high that arc back down
    for (let i = 0; i < 34; i++) {
      const u = hash2(i, seed);
      const a = hash2(seed, i) * Math.PI * 2;
      c.sparks.spawn(0, wx, dy, wz, Math.cos(a) * u * 1.6, 7 + u * 5, Math.sin(a) * u * 1.6, 1 + u * 0.6, 0.22 + u * 0.12, 0.06, u > 0.5 ? COL.gold : COL.hot, 1, 9);
    }
    for (let i = 0; i < 40; i++) {
      const u = hash2(i + 40, seed);
      const a = (i / 40 + hash2(seed, i + 40) * 0.1) * Math.PI * 2;
      const v = 2 + u * 3;
      c.sparks.spawn(0, wx, dy, wz, Math.cos(a) * v, 3 + u * 3, Math.sin(a) * v, 1.2 + u * 0.8, 0.08 + u * 0.05, 0.02, i % 3 === 0 ? COL.gold : COL.ember, 1, 7, 0.2);
    }
    for (let i = 0; i < 10; i++) {
      const u = hash2(i + 90, seed);
      const a = hash2(seed, i + 90) * Math.PI * 2;
      c.debris.spawn(0, wx, dy, wz, Math.cos(a) * (1.5 + u * 2.5), 4 + u * 4, Math.sin(a) * (1.5 + u * 2.5), 1.6, 0.1 + u * 0.12, 0.08, COL.rubble, 1, 12, 0.2, PLANE_Y.depths);
    }
    for (let i = 0; i < 8; i++) {
      const u = hash2(i + 120, seed);
      c.smoke.spawn(0, wx + (u - 0.5) * 1.2, dy + 0.6, wz + (hash2(seed, i + 120) - 0.5) * 1.2, (u - 0.5) * 0.4, 1.2 + u, (0.5 - u) * 0.4, 2.6, 0.4, 1.4, COL.rubble, 0.65, -0.1, 0.8);
    }
    this.rumble(t0 + 1600, 0.9);
  }

  /** Breach digs in progress: enemy ones we sense (tremors flagged `breach`) and our own breaching troopers. */
  private trackDigs(view: View, now: number): void {
    for (const d of this.digs.values()) d.seen = false;
    const mark = (x: number, y: number, ours: boolean, progress: number) => {
      const key = y * this.size + x;
      let d = this.digs.get(key);
      if (!d) {
        d = { since: now, seen: true, ours, progress, nextPuff: now };
        this.digs.set(key, d);
      }
      d.seen = true;
      d.ours = ours;
      d.progress = progress;
    };
    for (const t of view.tremors) if (t.breach) mark(t.x, t.y, false, -1);
    for (const e of view.entities)
      if (e.side === view.army && e.kind === 'trooper' && e.plane === 'depths' && e.state === 'breaching') mark(Math.floor(e.x), Math.floor(e.y), true, e.progress ?? -1);
    for (const [k, d] of this.digs) if (!d.seen) this.digs.delete(k);
  }

  private breakout(x: number, y: number, t0: number): void {
    const c = this.combat;
    const sy = PLANE_Y.surface + groundAt(x, y, this.terrain) + 0.2;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    c.rings.add(1, wx, sy, wz, 0.2, 3, t0, 750, COL.portal, 0.9);
    c.rings.add(1, wx, sy, wz, 0.1, 1.6, t0 + 90, 500, COL.portal, 0.6, RING.wash);
    c.rings.add(0, wx, PLANE_Y.depths + 0.5, wz, 0.2, 1.8, t0, 600, COL.portal, 0.8);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const u = hash2(i, Math.round(x * 7 + y));
      c.debris.spawn(1, wx + Math.cos(a) * 0.3, sy, wz + Math.sin(a) * 0.3, Math.cos(a) * (1.2 + u * 1.5), 4 + u * 4, Math.sin(a) * (1.2 + u * 1.5), 1.6, 0.12 + u * 0.12, 0.1, COL.rubble, 1, 12, 0.3, sy - 0.2);
      c.sparks.spawn(1, wx, sy, wz, -Math.sin(a) * 2.5, 1.2 + u, Math.cos(a) * 2.5, 0.7, 0.1, 0.02, COL.portal, 1, 1);
    }
    for (let i = 0; i < 10; i++) c.smoke.spawn(1, wx, sy, wz, (hash2(i, 3) - 0.5) * 2.4, 1 + hash2(i, 4), (hash2(i, 5) - 0.5) * 2.4, 1.6, 0.3, 1, COL.dust, 0.7, 0, 1.4);
    this.rumble(t0 + 500, 0.5);
  }

  /** Cracks race outward from the charge along the fault; each cell's slab drops when the crack reaches it. */
  private openChasm(cells: { x: number; y: number }[], t0: number): void {
    // order the cells along their fault; the race starts at the middle (the charge) and runs both ways
    const idx = cells.map((c) => this.faultIndex(c.x, c.y));
    const sorted = idx.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const mid = sorted[(sorted.length - 1) >> 1]![0];
    const delay = (i: number) => Math.abs(idx[i]! - mid) * RACE_MS;
    let last = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const d = delay(i);
      last = Math.max(last, d);
      this.slab(c.x + 0.5, c.y + 0.5, t0 + d);
      this.queue.push(t0 + d, c.x + 0.5, c.y + 0.5);
    }
    // the racing crack: hot tracers from cell to cell, outward from the middle
    for (let j = 0; j + 1 < sorted.length; j++) {
      const [va, ia] = sorted[j]!;
      const [vb, ib] = sorted[j + 1]!;
      const outward = Math.abs(vb - mid) > Math.abs(va - mid);
      const from = cells[outward ? ia : ib]!;
      const to = cells[outward ? ib : ia]!;
      const start = t0 + Math.min(delay(ia), delay(ib));
      const y = PLANE_Y.surface + 0.12;
      this.combat.shots.add(EFFECT_VISUALS.fault, 1, worldX(from.x + 0.5, this.size), y, worldZ(from.y + 0.5, this.size), 1, worldX(to.x + 0.5, this.size), y, worldZ(to.y + 0.5, this.size), start, start + RACE_MS, COL.hot);
    }
    this.rumble(t0 + last + 1400, 0.65);
  }

  private faultIndex(x: number, y: number): number {
    for (const f of this.faults) {
      const i = f.cells.findIndex((c) => c.x === x && c.y === y);
      if (i >= 0) return i;
    }
    return x + y;
  }

  private slab(x: number, y: number, start: number): void {
    if (this.ns >= SLAB_CAP) return;
    const i = this.ns++;
    this.sx[i] = worldX(x, this.size);
    this.sz[i] = worldZ(y, this.size);
    this.st[i] = start;
    this.sr[i] = hash2(Math.round(x), Math.round(y)) - 0.5;
  }

  /** Dust and rubble when a chasm cell gives way (rubble falls all the way into the Depths). */
  private burst(x: number, y: number, t0: number): void {
    const c = this.combat;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    const sy = PLANE_Y.surface + 0.1;
    c.rings.add(1, wx, sy, wz, 0.2, 1.6, t0, 700, COL.dust, 0.6, RING.wash);
    for (let i = 0; i < 6; i++) {
      const u = hash2(i, Math.round(x * 13 + y));
      c.smoke.spawn(1, wx + (u - 0.5), sy, wz + (hash2(Math.round(y * 5), i) - 0.5), (u - 0.5) * 1.2, 1 + u, (0.5 - u) * 1.2, 1.8, 0.3, 0.9, COL.dust, 0.7, 0, 1.2);
      c.debris.spawn(1, wx + (u - 0.5) * 0.8, sy - 0.3, wz + (hash2(i, 9) - 0.5) * 0.8, (u - 0.5) * 0.6, -0.5 - u * 2, (hash2(9, i) - 0.5) * 0.6, 2.4, 0.14 + u * 0.12, 0.12, COL.rubble, 1, 14, 0, PLANE_Y.depths + 0.3);
      c.sparks.spawn(1, wx, sy, wz, (u - 0.5) * 3, 1.5 + u * 2, (hash2(i, 2) - 0.5) * 3, 0.5, 0.08, 0.02, COL.hot, 1, 6);
    }
    c.rings.add(0, wx, PLANE_Y.depths + 0.5, wz, 0.2, 1.4, t0 + 1600, 800, COL.dust, 0.5, RING.wash);
  }

  private bridge(x: number, y: number, t0: number): void {
    const c = this.combat;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    const sy = PLANE_Y.surface + 0.15;
    c.rings.add(1, wx, sy, wz, 0.2, 1.3, t0, 650, COL.gold, 0.9);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.smoke.spawn(1, wx + Math.cos(a) * 0.4, sy, wz + Math.sin(a) * 0.4, Math.cos(a) * 0.6, 0.6, Math.sin(a) * 0.6, 1.2, 0.2, 0.6, COL.dust, 0.6, 0, 1.5);
      c.sparks.spawn(1, wx, sy, wz, Math.cos(a) * 1.5, 1.4, Math.sin(a) * 1.5, 0.5, 0.08, 0.02, COL.gold, 1, 5);
    }
  }

  private rail(x: number, y: number): void {
    const c = this.combat;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    const dy = PLANE_Y.depths + 0.2;
    for (let i = 0; i < 6; i++) {
      const u = hash2(i, Math.round(x * 3 + y * 7));
      c.sparks.spawn(0, wx + (u - 0.5) * 0.6, dy, wz + (hash2(7, i) - 0.5) * 0.6, (u - 0.5) * 2, 1 + u, (0.5 - u) * 2, 0.35, 0.06, 0.02, COL.steel, 1, 7);
    }
  }

  private magma(x: number, y: number, t0: number): void {
    const c = this.combat;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    const dy = PLANE_Y.depths + 0.3;
    c.rings.add(0, wx, dy, wz, 0.2, 1.2, t0, 600, COL.ember, 0.7, RING.wash);
    for (let i = 0; i < 7; i++) {
      const u = hash2(i, Math.round(x * 11 + y * 5));
      c.sparks.spawn(0, wx + (u - 0.5) * 0.7, dy, wz + (hash2(u * 100, i) - 0.5) * 0.7, (u - 0.5) * 1.4, 1.5 + u * 2, (0.5 - u) * 1.4, 0.7 + u * 0.4, 0.09, 0.02, u > 0.4 ? COL.ember : COL.gold, 1, 4);
    }
    c.smoke.spawn(0, wx, dy + 0.2, wz, 0, 0.8, 0, 1.6, 0.25, 0.8, COL.rubble, 0.5, 0, 1);
  }

  private cool(x: number, y: number): void {
    const c = this.combat;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    const dy = PLANE_Y.depths + 0.35;
    for (let i = 0; i < 4; i++) {
      const u = hash2(i, Math.round(x * 17 + y * 3));
      c.smoke.spawn(0, wx + (u - 0.5) * 0.6, dy, wz + (hash2(i, 4) - 0.5) * 0.6, 0, 0.9 + u * 0.5, 0, 2.2, 0.2, 0.7, COL.steam, 0.55, -0.2, 0.8);
    }
  }

  /** Crater ore going up in the lava: a gold flash and gold sparks over the flooding cell. */
  private cacheBurned(x: number, y: number, t0: number): void {
    const c = this.combat;
    const wx = worldX(x, this.size);
    const wz = worldZ(y, this.size);
    const dy = PLANE_Y.depths + 0.3;
    c.rings.add(0, wx, dy, wz, 0.2, 1.4, t0, 700, COL.gold, 0.8);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.sparks.spawn(0, wx, dy, wz, Math.cos(a) * 1.2, 2 + hash2(i, Math.round(x * 13 + y * 7)) * 1.5, Math.sin(a) * 1.2, 0.6, 0.08, 0.02, COL.gold, 1, 5);
    }
  }

  private rumble(until: number, strength: number): void {
    this.rumbleUntil = Math.max(this.rumbleUntil, until);
    this.rumbleK = Math.max(this.rumbleK, strength);
  }

  frame(now: number, army: ArmyId): void {
    const c = this.combat;
    // queued bursts whose crack has arrived
    for (let i = 0; i < this.queue.length; ) {
      if (this.queue[i]! > now) {
        i += 3;
        continue;
      }
      this.burst(this.queue[i + 1]!, this.queue[i + 2]!, this.queue[i]!);
      this.queue.splice(i, 3);
    }
    if (now < this.rumbleUntil && (this.focus === 'surface' || this.focus === 'depths')) c.shake = Math.max(c.shake, this.rumbleK * (0.6 + Math.random() * 0.4));
    else if (now >= this.rumbleUntil) this.rumbleK = 0;
    // embers off live lava: a few a second over the flood, each from a cell along a fixed stride
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (this.nEmbers > 0 && fadeValue.depths > 0.03) {
      this.emberDue += dt * Math.min(this.nEmbers, EMBER_CELLS) * EMBER_RATE;
      while (this.emberDue >= 1) {
        this.emberDue--;
        const s = this.emberSeq++;
        const cell = this.embers[(s * 7919) % this.nEmbers]!;
        const u = hash2(s & 1023, cell);
        const v = hash2(cell, s & 511);
        const x = (cell % this.size) + 0.2 + u * 0.6;
        const z = Math.floor(cell / this.size) + 0.2 + v * 0.6;
        c.sparks.spawn(0, worldX(x, this.size), PLANE_Y.depths + 0.05, worldZ(z, this.size), (u - 0.5) * 0.6, 1.3 + v * 1.6, (v - 0.5) * 0.6, 0.9 + u * 0.6, 0.05 + v * 0.03, 0.01, u > 0.6 ? COL.gold : COL.ember, 1, 2.2, 0.4);
      }
    } else this.emberDue = 0;
    this.chargeModels.frame(now, dt, c.sparks);

    // falling slabs: hold, tip, drop into the trench
    const fs = fadeValue.surface;
    let out = 0;
    for (let i = 0; i < this.ns; ) {
      const k = (now - this.st[i]!) / 1000;
      if (k > 1.6) {
        const j = --this.ns;
        this.sx[i] = this.sx[j]!;
        this.sz[i] = this.sz[j]!;
        this.st[i] = this.st[j]!;
        this.sr[i] = this.sr[j]!;
        continue;
      }
      const t = Math.max(0, k);
      const drop = 4.5 * t * t;
      const tilt = this.sr[i]! * t * 2.4;
      const shiver = k < 0 ? Math.sin(now * 0.08 + i) * 0.03 : 0;
      writeMatrix(this.slabs.instanceMatrix.array as Float32Array, out++, this.sx[i]! + shiver, PLANE_Y.surface - drop, this.sz[i]!, tilt);
      i++;
    }
    this.slabs.count = fs > 0.03 ? out : 0;
    this.slabs.instanceMatrix.needsUpdate = true;

    // breach cracks + periodic dust puffs while the dig goes on
    let nc = 0;
    const arr = this.cracks.instanceMatrix.array as Float32Array;
    const tint = this.crackTint.array as Float32Array;
    const own = sideColor(army);
    for (const [key, d] of this.digs) {
      if (nc >= CRACK_CAP - 1) break;
      const x = (key % this.size) + 0.5;
      const y = Math.floor(key / this.size) + 0.5;
      const g = d.progress >= 0 ? d.progress : Math.min(1, (now - d.since) / (BREACH_S * 1000));
      const col = d.ours ? own : THREAT_COLOR;
      const sy = PLANE_Y.surface + groundAt(x, y, this.terrain) + 0.05;
      const r = 0.9 + g * 1.1;
      if (fs > 0.03) nc = putDecal(arr, tint, nc, worldX(x, this.size), sy, worldZ(y, this.size), r, col, Math.max(0.15, g) * fs);
      if (fadeValue.depths > 0.03) nc = putDecal(arr, tint, nc, worldX(x, this.size), PLANE_Y.depths + 0.08, worldZ(y, this.size), 0.7, col, Math.max(0.15, g) * fadeValue.depths);
      if (now >= d.nextPuff) {
        d.nextPuff = now + 420 - g * 220;
        const u = hash2(Math.round(now) & 1023, key);
        const ox = (u - 0.5) * r;
        const oz = (hash2(key, Math.round(now) & 511) - 0.5) * r;
        c.smoke.spawn(1, worldX(x, this.size) + ox, sy, worldZ(y, this.size) + oz, 0, 0.5 + g, 0, 1, 0.12, 0.4 + g * 0.3, COL.dust, 0.6, 0, 1.5);
        c.debris.spawn(1, worldX(x, this.size) + ox, sy, worldZ(y, this.size) + oz, ox, 1.2 + g * 1.5, oz, 0.6, 0.06 + g * 0.05, 0.05, COL.rubble, 1, 12, 0, sy - 0.05);
        if (u > 0.6) c.rings.add(1, worldX(x, this.size), sy, worldZ(y, this.size), 0.2, r * 1.3, now, 600, COL.dust, 0.3 + g * 0.3, RING.wash);
      }
    }
    this.cracks.count = nc;
    this.cracks.instanceMatrix.needsUpdate = true;
    this.crackTint.needsUpdate = true;
    this.drawStamps(now, army);
  }

  /**
   * One stamp per planted charge (Surface: a faint dashed danger ring on the collapse edge with a dynamite glyph, at
   * full strength in the public window; the Depths draws the charge itself), breach dig (Surface + Depths) and falling
   * asteroid (Surface + Sky).
   */
  private drawStamps(now: number, army: ArmyId): void {
    const arr = this.stamps.instanceMatrix.array as Float32Array;
    const tint = this.stampTint.array as Float32Array;
    const data = this.stampData.array as Float32Array;
    const own = sideColor(army);
    // shown wherever the plane is drawn at all; fainter on ghosted planes
    const fs = fadeValue.surface > 0.03 ? 0.45 + 0.55 * focusValue.surface : 0;
    const fd = fadeValue.depths > 0.03 ? 0.45 + 0.55 * focusValue.depths : 0;
    const fk = fadeValue.sky > 0.03 ? 0.45 + 0.55 * focusValue.sky : 0;
    let n = 0;
    for (let i = 0; i < this.charges.length; i++) {
      const c = this.charges[i]!;
      const left = chargeLeft(c, this.viewTick, this.viewMs, this.msPerTick, now);
      // blown on screen: the collapse effect takes over
      if (!fs || left <= 0) continue;
      const el = chargeElapsed(left, this.chargeModels.fuseS(i));
      const heat = chargeHeat(left, this.chargeModels.publicS);
      const glyph = this.onFault(c.x, c.y) ? GLYPH.tntChasm : GLYPH.tnt;
      const col = relation(army, c.side) === 'hostile' ? THREAT_COLOR : sideColor(c.side);
      const x = c.x + 0.5;
      const y = c.y + 0.5;
      const R = this.collapseRadius / STAMP_RING;
      n = putStamp(arr, tint, data, n, worldX(x, this.size), PLANE_Y.surface + groundTop(x, y, R, this.terrain) + 0.06, worldZ(y, this.size), R, col, fs * (CHARGE_FAINT + (1 - CHARGE_FAINT) * heat), el, glyph, left, heat);
    }
    for (const [key, d] of this.digs) {
      const x = (key % this.size) + 0.5;
      const y = Math.floor(key / this.size) + 0.5;
      const el = d.progress >= 0 ? d.progress : Math.min(1, (now - d.since) / (BREACH_S * 1000));
      const left = d.progress >= 0 ? ((1 - d.progress) * ECON.breachTicks) / TICK_RATE : Math.max(0, BREACH_S - (now - d.since) / 1000);
      const col = d.ours ? own : THREAT_COLOR;
      if (fs) n = putStamp(arr, tint, data, n, worldX(x, this.size), PLANE_Y.surface + groundTop(x, y, 1.3, this.terrain) + 0.06, worldZ(y, this.size), 1.3, col, fs, el, GLYPH.breach, left);
      if (fd) n = putStamp(arr, tint, data, n, worldX(x, this.size), PLANE_Y.depths + DEPTHS_TOP, worldZ(y, this.size), 0.8, col, fd, el, GLYPH.breach, left);
    }
    for (const imp of this.impacts) {
      const impactS = (Math.max(1, imp.tick - (imp.start ?? imp.tick - ECON.impactTicks)) * this.msPerTick) / 1000;
      const left = Math.max(0, (this.viewMs + (imp.tick - this.viewTick) * this.msPerTick - now) / 1000);
      const el = clamp(1 - left / impactS, 0, 1);
      const R = this.impactRadii.get(imp.id) ?? imp.radius ?? ECON.impactRadius;
      if (fs) n = putStamp(arr, tint, data, n, worldX(imp.x, this.size), PLANE_Y.surface + groundTop(imp.x, imp.y, R, this.terrain) + 0.06, worldZ(imp.y, this.size), R, THREAT_COLOR, fs, el, GLYPH.impact, left);
      if (fk) n = putStamp(arr, tint, data, n, worldX(imp.x, this.size), PLANE_Y.sky + 0.5, worldZ(imp.y, this.size), R, THREAT_COLOR, fk, el, GLYPH.impact, left);
    }
    // the Mother Lode's fuse: over each lode cluster we know, as wide as its blast
    if (fd && this.ventAt > 0) {
      const left = Math.max(0, (this.viewMs + (this.ventAt - this.viewTick) * this.msPerTick - now) / 1000);
      const el = clamp(1 - left / this.fuseS, 0, 1);
      for (let i = 0; i < this.nLodeStamps; i++) {
        const o = i * 3;
        n = putStamp(arr, tint, data, n, this.lodeStamps[o]!, PLANE_Y.depths + DEPTHS_TOP, this.lodeStamps[o + 1]!, this.lodeStamps[o + 2]!, THREAT_COLOR, fd, el, GLYPH.impact, left);
      }
    }
    this.stamps.count = n;
    this.stamps.instanceMatrix.needsUpdate = true;
    this.stampTint.needsUpdate = true;
    this.stampData.needsUpdate = true;
  }

  private onFault(x: number, y: number): boolean {
    for (const f of this.faults) for (const c of f.cells) if (c.x === x && c.y === y) return true;
    return false;
  }
}

/**
 * The stamp, on a 2×2 quad's uv (ported from lookdev `kit.telegraphPattern` + `dirs/ink.ts` telegraph): amber ring
 * between two ink rims, 12 ink ticks, the elapsed share of the countdown as a world-anchored hatched pie (clockwise
 * from 12 o'clock), the kind's ink glyph in the middle. Last 2 s: faster pulse and a reticle sweep. A charge stamp
 * (data w = its public-window heat, ≥ 0; else −1) marches a dashed ring instead, without ticks, its pie hatched faintly
 * until the heat brings up the full pie and a pulsing halo.
 */
function stampMaterial(tintAttr: InstancedBufferAttribute, dataAttr: InstancedBufferAttribute): MeshBasicNodeMaterial {
  const tint = instancedDynamicBufferAttribute<'vec4'>(tintAttr, 'vec4') as V4;
  const sd = instancedDynamicBufferAttribute<'vec4'>(dataAttr, 'vec4') as V4;
  const q = uv().sub(0.5).mul(2);
  const r = q.length();
  const aa = fwidth(r).mul(1.2);
  const band = (lo: number, hi: number): F1 =>
    smoothstep(aa.negate().add(lo), aa.add(lo), r).mul(float(1).sub(smoothstep(aa.negate().add(hi), aa.add(hi), r))) as F1;
  const ang = atan(q.y, q.x).div(Math.PI * 2).add(0.5);
  // a charge: dashes marching round the ring, quicker once public
  const charge = sd.w.greaterThanEqual(0);
  const heat = sd.w.max(0);
  const dashAt = fract(ang.mul(28).sub(time.mul(mix(float(0.15), float(0.9), heat))));
  const dashW = fwidth(ang).mul(28);
  const dash = charge.select(smoothstep(dashW.negate(), dashW, float(0.55).sub(dashAt)).mul(smoothstep(dashW.negate(), dashW, dashAt)), float(1));
  const ring = band(0.8, 0.88).mul(dash);
  const rims = max(band(0.77, 0.8), band(0.88, 0.91)).mul(dash);
  const ticks = smoothstep(0.38, 0.44, abs(fract(ang.mul(12)).sub(0.5))).mul(band(0.91, 1)).mul(charge.select(float(0), float(1)));
  const inner = float(1).sub(smoothstep(0.74, 0.76, r));
  const along = fract(ang.sub(0.25));
  const el = sd.x;
  const pie = float(1).sub(smoothstep(el.sub(0.004), el, along)).mul(inner);
  const hatched = lines(positionWorld.x.add(positionWorld.z).mul(6) as F1, 0.22);
  const fill = pie.mul(hatched.mul(0.75).add(0.14)).add(inner.mul(0.05)).mul(charge.select(mix(float(0.45), float(1), heat), float(1)));
  // glyphs
  const ax = abs(q.x);
  const stroke = (d: F1): F1 => float(1).sub(smoothstep(0.022, 0.04, d)) as F1;
  // a dynamite bundle: three rounded sticks of red paper outlined in fine ink, a solid ink band across them, and a
  // fuse rising to a hot spark dot (paint the other glyphs never use)
  const fine = (d: F1): F1 => float(1).sub(smoothstep(0.012, 0.024, d)) as F1;
  const stickD = (cx: number): F1 => max(abs(vec2(q.x.sub(cx), q.y)).sub(vec2(0.03, 0.24)), 0).length().sub(0.026) as F1;
  const sticks = min(min(stickD(-0.14), stickD(0)), stickD(0.14)) as F1;
  const tied = float(1).sub(smoothstep(0.04, 0.052, abs(q.y))).mul(float(1).sub(smoothstep(0.205, 0.22, ax)));
  const fp = q.sub(vec2(0, 0.26));
  const fd = vec2(0.1, 0.15);
  const fuse = fine(fp.sub(fd.mul(dot(fp, fd).div(dot(fd, fd)).clamp(0, 1))).length() as F1);
  const tntInk = max(max(fine(abs(sticks) as F1), tied), fuse);
  // on a fault: the chasm's zigzag under the bundle
  const zigLow = stroke(abs(q.y.add(0.44).sub(abs(fract(q.x.mul(4).add(0.5)).sub(0.5)).mul(0.36).sub(0.09))) as F1).mul(float(1).sub(smoothstep(0.34, 0.36, ax)));
  const chevrons = max(stroke(abs(q.y.sub(0.13).add(ax.mul(0.9))) as F1), stroke(abs(q.y.add(0.07).add(ax.mul(0.9))) as F1)).mul(float(1).sub(smoothstep(0.2, 0.22, ax)));
  const star = smoothstep(0.38, 0.45, abs(fract(ang.mul(8)).sub(0.5))).mul(float(1).sub(smoothstep(0.24, 0.26, r))).max(float(1).sub(smoothstep(0.06, 0.08, r)));
  const g = sd.y;
  const tnt = g.lessThan(1.5).select(float(1), float(0));
  const glyph = g.lessThan(0.5).select(tntInk, g.lessThan(1.5).select(max(tntInk, zigLow), g.lessThan(2.5).select(chevrons, star)));
  const paper = float(1).sub(smoothstep(-0.006, 0.006, sticks)).mul(tnt);
  const spark = float(1).sub(smoothstep(0.04, 0.055, q.sub(vec2(0.11, 0.43)).length())).mul(tnt);
  // final seconds: faster pulse + a sweeping reticle hand trailing a wedge
  const urgent = float(1).sub(smoothstep(1.8, 2.2, sd.z));
  const pulse = sin(time.mul(mix(float(3), float(12), urgent))).mul(0.5).add(0.5);
  const sweep = smoothstep(0.8, 1, fract(along.sub(time.mul(0.9)))).mul(inner).mul(urgent).mul(0.45);
  // a public charge: a soft halo just outside its ring, pulsing
  const halo = band(0.91, 1).mul(smoothstep(1, 0.91, r)).mul(heat).mul(pulse.mul(0.5).add(0.3));
  const ink = color(INK.surface);
  const inked = max(max(ticks, glyph), rims);
  const m = overlay(new MeshBasicNodeMaterial());
  // hatch lines drawn in a darker amber so the pie reads on cream paper too
  const stamp = mix(mix(tint.xyz, ink, pie.mul(hatched).mul(0.3)), color(CHARGE_PAINT.stick), paper);
  m.colorNode = mix(mix(stamp, ink, inked), color(CHARGE_PAINT.spark), spark).add(tint.xyz.mul(halo.mul(0.6)));
  m.opacityNode = max(max(max(ring, inked), max(fill, sweep)), max(halo, max(paper, spark))).mul(tint.w).mul(mix(float(0.85), float(0.6), urgent).add(pulse.mul(mix(float(0.15), float(0.4), urgent)))).min(1);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -3;
  m.polygonOffsetUnits = -3;
  return m;
}

/** Highest ground under a stamp (centre + four rim points), so the flat stamp is not swallowed by the heightfield. */
function groundTop(x: number, y: number, r: number, terrain: TerrainField): number {
  const k = r * 0.7;
  return Math.max(groundAt(x, y, terrain), groundAt(x + k, y, terrain), groundAt(x - k, y, terrain), groundAt(x, y + k, terrain), groundAt(x, y - k, terrain));
}

/** `heat`: a charge stamp's public-window heat (0..1, dashed ring); −1 for every other stamp. */
function putStamp(m: Float32Array, tint: Float32Array, data: Float32Array, i: number, x: number, y: number, z: number, r: number, c: Color, a: number, elapsed: number, glyph: number, left: number, heat = -1): number {
  if (i >= STAMP_CAP) return i;
  const o = i * 4;
  data[o] = elapsed; data[o + 1] = glyph; data[o + 2] = left; data[o + 3] = heat;
  return putDecal(m, tint, i, x, y, z, r, c, a);
}

/** Write a translation + Y-tilt (about the x axis) matrix at instance `i`. */
function writeMatrix(m: Float32Array, i: number, x: number, y: number, z: number, tilt: number): void {
  const o = i * 16;
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  m[o] = 1; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = c; m[o + 6] = s; m[o + 7] = 0;
  m[o + 8] = 0; m[o + 9] = -s; m[o + 10] = c; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}

/** Flat decal of radius r at (x, y, z) with tint (rgb) and growth/alpha in w. */
function putDecal(m: Float32Array, tint: Float32Array, i: number, x: number, y: number, z: number, r: number, c: Color, w: number): number {
  const o = i * 16;
  m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = r; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
  const t = i * 4;
  tint[t] = c.r; tint[t + 1] = c.g; tint[t + 2] = c.b; tint[t + 3] = w;
  return i + 1;
}
