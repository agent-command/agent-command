/** Spawning and rally: structure footprints on the surface grid, unit spawn exits, formation slots and rally points. */
import {
  type Econ,
  footprintDistance,
  isOpenCell,
  isCellStructure,
  isNeutralKind,
  isStatKind,
  type Kind,
  type Plane,
  STATS,
  type UnitKind,
} from '../rules/contract.ts';
import { searchDepths } from '../nav/nav.ts';
import { wallHit } from '../rules/derelict.ts';
import { adjacent4, cellCentreX, cellCentreY, cellFor, cellOf, cellOfEnt, clampPos } from '../util/grid.ts';
import { norm, norm2, sq } from '../util/math.ts';
import { type Army, canonCell, canonX, canonY, NEUTRAL, rotCell, rotX, rotY, type SideId } from '../util/teams.ts';
import { DEPLOY_NONE, HEX_PACKING, HEX_RING, MAX_SLOT_RINGS, SLOT_RING_DIRS, SNAP_EPS } from './constants.ts';
import { bySeq, Ent } from './ent.ts';
import type { Sim } from './sim.ts';
import type { Disc } from './state.ts';

/** The rule holding each plane's default rally distance past the Spire footprint edge. */
const RALLY_RULE = { depths: 'depthsRally', surface: 'surfaceRally', sky: 'skyRally', orbit: 'orbitRally' } as const satisfies Record<Plane, keyof Econ>;

export class SimSpawn {
  stampFootprint(this: Sim, out: Uint8Array, kind: Kind, x: number, y: number): void {
    const f = isStatKind(kind) ? this.stats[kind].footprint : undefined;
    if (!f) return;
    for (let yy = Math.max(0, Math.floor(y - f.h / 2)); yy < Math.min(this.size, Math.ceil(y + f.h / 2)); yy++) {
      for (let xx = Math.max(0, Math.floor(x - f.w / 2)); xx < Math.min(this.size, Math.ceil(x + f.w / 2)); xx++) out[yy * this.size + xx] = 1;
    }
  }

  /** Remembered footprints, never hidden live positions, determine an army's flow fields. */
  refreshSurfaceFootprints(this: Sim, army: Army): void {
    const t = this.armies[army]!;
    const next = this.footprintScratch;
    next.set(this.block);
    for (const e of this.ents) {
      if (!e.dead && e.structure && e.plane === 'surface' && (e.side === army || e.kind === 'spire' || this.sees(army, e))) this.stampFootprint(next, e.kind, e.x, e.y);
    }
    for (const g of t.group.memory.values()) if (g.plane === 'surface') this.stampFootprint(next, g.kind, g.x, g.y);
    const nav = this.surfaceNav[army]!;
    let changed = false;
    for (let c = 0; c < this.n; c++) if (nav[c] !== next[c]) { nav[c] = next[c]!; changed = true; }
    if (changed) this.holesVersion++;
    next.fill(0);
    for (const e of this.ents) {
      if (!e.dead && e.structure && !isCellStructure(e.kind) && e.plane === 'depths' && (e.side === army || e.kind === 'spire' || this.sees(army, e))) this.stampFootprint(next, e.kind, e.x, e.y);
      // Visible hostile shields are impassable to planners too, not merely to the final movement step.
      // Mobile units have no fog memory: never stamp an unseen Warden's current position or stance.
      if (!e.dead && e.plane === 'depths' && e.deploy !== DEPLOY_NONE && this.hostile(army, e.side) && this.sees(army, e) && this.deploySpec(e)?.blocksCell) next[cellOfEnt(e, this.size)] = 1;
    }
    for (const g of t.group.memory.values()) if (g.plane === 'depths' && !isCellStructure(g.kind)) this.stampFootprint(next, g.kind, g.x, g.y);
    const depths = this.depthNav[army]!;
    let depthsChanged = false;
    for (let c = 0; c < this.n; c++) if (depths[c] !== next[c]) { depths[c] = next[c]!; t.designationDirty = depthsChanged = true; }
    if (depthsChanged) this.depthsVersion++;
  }

  surfaceBlocked(this: Sim, side: SideId, x: number, y: number): boolean {
    const c = cellFor(this.armyFrame[side]!, x, y, this.size);
    return this.block[c] !== 0 || this.surfaceBodies[c] !== 0;
  }

  /**
   * A new unit of `kind` for `army`, standing just outside its producer's footprint (the Spire segment, or `producer`)
   * on the side facing the plane's rally point (see exitPoint).
   */
  spawnUnit(this: Sim, army: Army, kind: UnitKind, plane: Plane, producer?: Ent): Ent {
    const t = this.armies[army]!;
    const from = producer ?? this.spireAt[army]!;
    const f = STATS[producer && isStatKind(producer.kind) ? producer.kind : 'spire'].footprint!;
    const rally = t.rally[plane];
    const at = this.exitPoint(army, plane, this.stats[kind].radius, from.x, from.y, f.w, f.h, rally.x, rally.y, t.spawnI++);
    const e = this.add(kind, army, plane, at.x, at.y);
    t.pop++;
    return e;
  }

  /**
   * Can a body of radius `r` stand at army-frame point (x, y) on `plane`? Inside the map; on the Surface off every
   * cell the army's planner treats as blocked (cliffs, water, holes, known footprints); in the Depths on known open
   * cells outside known footprints; in the Sky and Orbit clear of the structures the army knows of (its own, Spire
   * segments, seen ones), and in Orbit off the derelict's walls. Only cells the disc actually reaches count. Off the
   * Depths, a slot also keeps rules.movement.rallyClearance between the body and the army's own Spire segment, so
   * units never park on the Spire's exits.
   */
  slotOpen(this: Sim, army: Army, plane: Plane, x: number, y: number, r: number): boolean {
    if (x < r || y < r || x > this.size - r || y > this.size - r) return false;
    const k = this.armyFrame[army]!;
    if (plane !== 'depths') {
      const wx = rotX(k, x, y, this.size);
      const wy = rotY(k, x, y, this.size);
      const own = this.armies[army]!.spire[plane];
      if (!own.dead && footprintDistance(own.kind, own.x, own.y, wx, wy) - r < this.econ.rallyClearance) return false;
      if (plane === 'sky' || plane === 'orbit') {
        // Orbit slots stay off the derelict's walls (its ring counted solid: a slot must hold whatever the gates do).
        if (plane === 'orbit' && this.derelict && wallHit(this.derelict, false, x - this.derelict.x, y - this.derelict.y, r)) return false;
        for (const o of this.ents) {
          if (o.dead || !o.structure || o.plane !== plane || !isStatKind(o.kind) || !this.stats[o.kind].footprint) continue;
          if (o.side !== army && o.kind !== 'spire' && !this.sees(army, o)) continue;
          if (footprintDistance(o.kind, o.x, o.y, wx, wy) < r) return false;
        }
        return true;
      }
    }
    const nav = plane === 'surface' ? this.surfaceNav[army]! : this.depthNav[army]!;
    const known = this.armies[army]!.group.known;
    const x0 = Math.floor(x - r), x1 = Math.min(this.size - 1, Math.floor(x + r));
    const y0 = Math.floor(y - r), y1 = Math.min(this.size - 1, Math.floor(y + r));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (norm2(Math.max(cx - x, 0, x - cx - 1), Math.max(cy - y, 0, y - cy - 1)) >= sq(r)) continue;
        const c = rotCell(k, cy * this.size + cx, this.size);
        if (nav[c] || (plane === 'surface' ? this.block[c] : !isOpenCell(known[c]!))) return false;
      }
    }
    return true;
  }

  /**
   * The free point for a body of radius `r` nearest the centre of a hexagonal ring lattice around army-frame (gx, gy)
   * stepped by its own size (2r + slotGap): the first ring with a free point, and on it the point nearest the
   * preferred (px, py), ties to the lower lattice index. With `within` > 0, instead the free point nearest (px, py)
   * over every ring no farther than `within` tiles from the centre (ties to the inner ring). Free = open ground for
   * the plane and clear of every `placed` disc by slotGap. Null when no ring has one.
   */
  ringSlot(this: Sim, army: Army, plane: Plane, r: number, gx: number, gy: number, px: number, py: number, placed: readonly Disc[], within = 0): [number, number] | null {
    const gap = this.econ.slotGap;
    const free = (x: number, y: number): boolean => {
      if (!this.slotOpen(army, plane, x, y, r)) return false;
      for (const p of placed) if (norm2(p.x - x, p.y - y) < sq(p.r + r + gap - SNAP_EPS)) return false;
      return true;
    };
    let best: [number, number] | null = null;
    let bd = Infinity;
    if (free(gx, gy)) {
      if (!within) return [gx, gy];
      best = [gx, gy];
      bd = norm2(gx - px, gy - py);
    }
    const step = 2 * r + gap;
    for (let k = 1; k <= MAX_SLOT_RINGS && (!within || k * step <= within); k++) {
      const ring = HEX_RING * k * (k - 1);
      for (let j = 0; j < HEX_RING * k; j++) {
        const x = gx + SLOT_RING_DIRS[ring + 2 * j]! * k * step;
        const y = gy + SLOT_RING_DIRS[ring + 2 * j + 1]! * k * step;
        const d = norm2(x - px, y - py);
        if (d < bd && free(x, y)) {
          bd = d;
          best = [x, y];
        }
      }
      if (best && !within) return best;
    }
    return best;
  }

  /**
   * Destination slots for `units` gathering at world point (x, y) on their plane: one disc per unit sized by its body
   * radius plus slotGap, on ground that plane can stand on, clear of each other and of the `taken` discs (units already
   * standing or headed there). Each unit prefers its offset from the group centre, squeezed into the disc the group
   * fills when hex-packed, so a compact group keeps its layout (a single unit prefers the point itself); see
   * `placeSlots`. Computed in the army frame with units ordered by preferred distance, size and serial, so rotated
   * armies' slots rotate exactly. World points, in the order of `units`.
   */
  slotTargets(this: Sim, army: Army, plane: Plane, units: readonly Ent[], x: number, y: number, taken: readonly Disc[] = []): [number, number][] {
    const k = this.armyFrame[army]!;
    const size = this.size;
    // On the position grid: a rotated point round-tripped through the army frame lands on exactly the same value.
    const gx = clampPos(canonX(k, x, y, size), size);
    const gy = clampPos(canonY(k, x, y, size), size);
    const gap = this.econ.slotGap;
    // Sums in serial order (not the order units were listed in), so every army rounds them identically.
    let cx = 0;
    let cy = 0;
    let area = 0;
    for (const e of [...units].sort(bySeq)) {
      cx += canonX(k, e.x, e.y, size) / units.length;
      cy += canonY(k, e.x, e.y, size) / units.length;
      area += sq(e.radius + gap / 2);
    }
    const disc = Math.sqrt(area / HEX_PACKING);
    const wants = units.map((e, i) => {
      let ox = canonX(k, e.x, e.y, size) - cx;
      let oy = canonY(k, e.x, e.y, size) - cy;
      const len = norm(ox, oy);
      if (len > disc) {
        ox *= disc / len;
        oy *= disc / len;
      }
      return { i, e, px: gx + ox, py: gy + oy, d: Math.min(len, disc) };
    }).sort((a, b) => a.d - b.d || b.e.radius - a.e.radius || a.e.seq - b.e.seq);
    const slots = this.placeSlots(army, plane, gx, gy, wants.map((w) => ({ r: w.e.radius, px: w.px, py: w.py })), taken);
    const out: [number, number][] = units.map(() => [x, y]);
    wants.forEach((w, j) => {
      const [sx, sy] = slots[j]!;
      out[w.i] = [rotX(k, sx, sy, size), rotY(k, sx, sy, size)];
    });
    return out;
  }

  /**
   * Army-frame slots, in order, for bodies of radius `r` preferring army-frame points (px, py) around army-frame goal
   * (gx, gy): the preferred point when it is open ground for the plane and clear (by slotGap) of the world-frame
   * `taken` discs and every slot placed before it, else the nearest free point of a ring lattice around the goal
   * stepped by the body's own size, toward its preferred point; the goal itself when even that fails. On the
   * sign-symmetric position grid, so rotating back stays exact despite the army-frame round trip.
   */
  placeSlots(this: Sim, army: Army, plane: Plane, gx: number, gy: number, wants: readonly { r: number; px: number; py: number }[], taken: readonly Disc[]): [number, number][] {
    const k = this.armyFrame[army]!;
    const size = this.size;
    const gap = this.econ.slotGap;
    const placed: Disc[] = taken.map((p) => ({ x: canonX(k, p.x, p.y, size), y: canonY(k, p.x, p.y, size), r: p.r }));
    return wants.map(({ r, px, py }): [number, number] => {
      let slot: [number, number] | null = [px, py];
      if (!this.slotOpen(army, plane, px, py, r) || placed.some((p) => norm2(p.x - px, p.y - py) < sq(p.r + r + gap - SNAP_EPS))) {
        slot = this.ringSlot(army, plane, r, gx, gy, px, py, placed);
      }
      const [sx, sy] = slot ?? [gx, gy];
      placed.push({ x: sx, y: sy, r });
      return [clampPos(sx, size), clampPos(sy, size)];
    });
  }

  /**
   * Discs a new destination near world point (x, y) must keep clear of: the army's units on `plane` other than
   * `exclude` — idle ones where they stand, moving ones at their destination — whose disc comes within `reach`
   * tiles of the point. Own units only, so a slot never reveals what the army cannot see.
   */
  claimedDiscs(this: Sim, army: Army, plane: Plane, x: number, y: number, reach: number, exclude: readonly Ent[] = []): Disc[] {
    const out: Disc[] = [];
    for (const e of this.ents) {
      if (e.dead || e.hangar || !e.unit || e.side !== army || e.plane !== plane || exclude.includes(e)) continue;
      const o = e.order;
      const at = o.k === 'move' ? o : o.k === 'none' ? e : undefined;
      if (at && norm(at.x - x, at.y - y) - e.radius <= reach) out.push({ x: at.x, y: at.y, r: e.radius });
    }
    return out;
  }

  /**
   * Where a body of radius `r` leaves a producer footprint (world centre cx, cy; w×h) on `plane`: just outside a
   * footprint side or corner. Exits facing world point (tx, ty) come first: consecutive spawns (counter `k`) start at
   * successive facing exits and take the first free one, so they never stack. With every facing exit occupied, the
   * other exits in facing order; then the nearest free ring slot beyond the most facing exit.
   */
  exitPoint(this: Sim, army: Army, plane: Plane, r: number, cx: number, cy: number, w: number, h: number, tx: number, ty: number, k: number): { x: number; y: number } {
    const fr = this.armyFrame[army]!;
    const size = this.size;
    const ox = clampPos(canonX(fr, cx, cy, size), size);
    const oy = clampPos(canonY(fr, cx, cy, size), size);
    let dx = clampPos(canonX(fr, tx, ty, size), size) - ox;
    let dy = clampPos(canonY(fr, tx, ty, size), size) - oy;
    if (dx === 0 && dy === 0) {
      dx = this.size / 2 - ox;
      dy = this.size / 2 - oy;
    }
    const off = r + this.econ.slotGap;
    const exits: [number, number][] = [];
    for (const s of [1, -1]) {
      for (let i = 0; i < h; i++) exits.push([ox + s * (w / 2 + off), oy - h / 2 + i + 0.5]);
      for (let i = 0; i < w; i++) exits.push([ox - w / 2 + i + 0.5, oy + s * (h / 2 + off)]);
      for (const t of [1, -1]) exits.push([ox + s * (w / 2 + off * Math.SQRT1_2), oy + t * (h / 2 + off * Math.SQRT1_2)]);
    }
    const len = norm(dx, dy);
    const ranked = exits.map((p, i) => ({ p, i, dot: ((p[0] - ox) * dx + (p[1] - oy) * dy) / (len * norm(p[0] - ox, p[1] - oy)) }))
      .sort((a, b) => b.dot - a.dot || a.i - b.i);
    const facing = ranked.filter((e) => e.dot > 0);
    const order = [...facing.map((_, j) => facing[(k + j) % facing.length]!), ...ranked.filter((e) => e.dot <= 0)];
    // Every body on the plane, in the army frame.
    const bodies: Disc[] = [];
    for (const e of this.ents) {
      if (!e.dead && !e.hangar && e.plane === plane && !e.structure && !isNeutralKind(e.kind)) bodies.push({ x: canonX(fr, e.x, e.y, size), y: canonY(fr, e.x, e.y, size), r: e.radius });
    }
    const gap = this.econ.slotGap;
    for (const { p: [x, y] } of order) {
      if (this.slotOpen(army, plane, x, y, r) && bodies.every((b) => norm2(b.x - x, b.y - y) >= sq(b.r + r + gap - SNAP_EPS))) {
        const qx = clampPos(x, size);
        const qy = clampPos(y, size);
        return { x: rotX(fr, qx, qy, size), y: rotY(fr, qx, qy, size) };
      }
    }
    const [fx, fy] = ranked[0]!.p;
    const slot = this.ringSlot(army, plane, r, fx, fy, fx, fy, bodies) ?? [fx, fy];
    const qx = clampPos(slot[0], size);
    const qy = clampPos(slot[1], size);
    return { x: rotX(fr, qx, qy, size), y: rotY(fr, qx, qy, size) };
  }

  /**
   * Default rally point of `army`'s `plane` segment: rules.movement.<plane>Rally tiles past the Spire footprint edge
   * toward the map centre, on open ground for that plane (Surface: nearest walkable cell; Depths: nearest known open
   * cell connected to the root pocket). Army frame, so rotated armies' rallies rotate exactly.
   */
  defaultRally(this: Sim, army: Army, plane: Plane): { x: number; y: number } {
    const k = this.armyFrame[army]!;
    const size = this.size;
    const p = this.spireAt[army]!;
    const px = canonX(k, p.x, p.y, size);
    const py = canonY(k, p.x, p.y, size);
    const dx = this.size / 2 - px;
    const dy = this.size / 2 - py;
    const len = norm(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const fp = STATS.spire.footprint;
    const edge = Math.min(ux ? fp.w / 2 / Math.abs(ux) : Infinity, uy ? fp.h / 2 / Math.abs(uy) : Infinity);
    const d = edge + this.econ[RALLY_RULE[plane]];
    const x = clampPos(px + ux * d, this.size);
    const y = clampPos(py + uy * d, this.size);
    if (plane === 'surface') {
      const spot = this.openSurfaceNear(rotX(k, x, y, size), rotY(k, x, y, size), this.size, army);
      if (spot) return spot;
    } else if (plane === 'depths') {
      // Flood the known open cells from the root, then take the one nearest the point (ties: canonical cell order).
      const known = this.armies[army]!.group.known;
      const root = cellOf(p.x, p.y, this.size);
      const seen = new Uint8Array(this.n);
      const queue = [root];
      seen[root] = 1;
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i]!;
        const canon = canonCell(k, c, size);
        const cx = cellCentreX(canon, this.size);
        const cy = cellCentreY(canon, this.size);
        const outside = Math.abs(cx - px) > fp.w / 2 || Math.abs(cy - py) > fp.h / 2;
        const dd = norm(cx - x, cy - y);
        if (outside && (dd < bd || (dd === bd && canon < canonCell(k, best, size)))) {
          bd = dd;
          best = c;
        }
        for (const n of [c - 1, c + 1, c - this.size, c + this.size]) {
          if (n < 0 || n >= this.n || seen[n] || !adjacent4(n, c, this.size) || !isOpenCell(known[n]!)) continue;
          seen[n] = 1;
          queue.push(n);
        }
      }
      if (best >= 0) return { x: cellCentreX(best, this.size), y: cellCentreY(best, this.size) };
    }
    return { x: rotX(k, x, y, size), y: rotY(k, x, y, size) };
  }

  /**
   * A rally slot for a body of radius `r` arriving at world point (x, y) from producer `from`: a block of slots
   * stepped by its own size (2r + slotGap) that grows backward toward the producer and sideways from the rally point,
   * in square shells (shell s: its side columns front to back, then its back row centre out). Arrivals take the first
   * free slot, so earlier units stand ahead of later ones and nobody has to push through the queue. Free = open ground
   * for the plane, clear of `taken` by slotGap and, on the open planes, rules.movement.rallyClearance clear of the
   * producer's footprint (backward rows that reach it are skipped, so the block widens instead and units never park
   * against the Spire or its exits). Depths slots are tunnel cells, one body per cell (see depthsSlot). Army frame,
   * so rotated armies' slots rotate exactly. Null when every shell up to MAX_SLOT_RINGS is full.
   */
  rallySlot(this: Sim, army: Army, plane: Plane, r: number, x: number, y: number, from: Ent, taken: readonly Disc[]): [number, number] | null {
    const k = this.armyFrame[army]!;
    const size = this.size;
    const placed = taken.map((p) => ({ x: canonX(k, p.x, p.y, size), y: canonY(k, p.x, p.y, size), r: p.r }));
    const world = (slot: [number, number]): [number, number] => {
      const qx = clampPos(slot[0], size);
      const qy = clampPos(slot[1], size);
      return [rotX(k, qx, qy, size), rotY(k, qx, qy, size)];
    };
    if (plane === 'depths') {
      const slot = this.depthsSlot(army, r, x, y, placed);
      return slot && world(slot);
    }
    const gx = clampPos(canonX(k, x, y, size), size);
    const gy = clampPos(canonY(k, x, y, size), size);
    let ux = gx - clampPos(canonX(k, from.x, from.y, size), size);
    let uy = gy - clampPos(canonY(k, from.x, from.y, size), size);
    const len = norm(ux, uy);
    if (len === 0) {
      ux = 1;
      uy = 0;
    } else {
      ux /= len;
      uy /= len;
    }
    const gap = this.econ.slotGap;
    const step = 2 * r + gap;
    const clear = isStatKind(from.kind) && this.stats[from.kind].footprint ? this.econ.rallyClearance : -Infinity;
    const free = (row: number, col: number): [number, number] | null => {
      const sx = gx - ux * row * step - uy * col * step;
      const sy = gy - uy * row * step + ux * col * step;
      if (!this.slotOpen(army, plane, sx, sy, r)) return null;
      if (clear > -Infinity && footprintDistance(from.kind, from.x, from.y, rotX(k, sx, sy, size), rotY(k, sx, sy, size)) - r < clear) return null;
      for (const p of placed) if (norm2(p.x - sx, p.y - sy) < sq(p.r + r + gap - SNAP_EPS)) return null;
      return [sx, sy];
    };
    for (let s = 0; s <= MAX_SLOT_RINGS; s++) {
      for (let row = 0; row < s; row++) {
        const slot = free(row, s) ?? free(row, -s);
        if (slot) return world(slot);
      }
      for (let c = 0; c <= s; c++) {
        const slot = free(s, c) ?? (c ? free(s, -c) : null);
        if (slot) return world(slot);
      }
    }
    return null;
  }

  /**
   * A Depths rally slot: the centre of the tunnel cell nearest (by steps through the army's known open cells) the
   * rally cell at world (x, y) that no army-frame `placed` disc reaches into, so units stand one to a cell where the
   * tunnels allow instead of piling into the rally cell. Flooded in the army frame with a fixed neighbour order, so
   * rotated armies pick rotated cells. Null when no free cell is in reach.
   */
  depthsSlot(this: Sim, army: Army, r: number, x: number, y: number, placed: readonly Disc[]): [number, number] | null {
    const k = this.armyFrame[army]!;
    const size = this.size;
    const start = canonCell(k, cellFor(k, x, y, size), size);
    const seen = new Set([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const f = queue[i]!;
      const cx = cellCentreX(f, size);
      const cy = cellCentreY(f, size);
      if (this.slotOpen(army, 'depths', cx, cy, r) && placed.every((p) => Math.abs(p.x - cx) >= 0.5 || Math.abs(p.y - cy) >= 0.5)) return [cx, cy];
      if (queue.length > MAX_SLOT_RINGS * MAX_SLOT_RINGS) break;
      for (const n of [f - 1, f + 1, f - size, f + size]) {
        if (n < 0 || n >= this.n || seen.has(n) || !adjacent4(n, f, size)) continue;
        seen.add(n);
        const c = rotCell(k, n, size);
        if (isOpenCell(this.armies[army]!.group.known[c]!) && !this.depthNav[army]![c]) queue.push(n);
      }
    }
    return null;
  }

  /**
   * New units head for their segment's rally point (fight-move if armed, workers just move), each to its own slot of
   * the rally block (rallySlot) clear of the army's units already standing or headed there. A rally they cannot walk
   * to gives way to the nearest ground they can (Surface) or the default rally (Depths), so nobody is left standing
   * at the exit. `from` is the producer they left.
   */
  sendToRally(this: Sim, u: Ent, x: number, y: number, from: Ent): void {
    const fight = this.armed(u) && !this.capable(u, 'carry');
    const walk = (cx: number, cy: number): boolean => {
      const goal = cellFor(u.frame, cx, cy, this.size);
      // Reachability only (null or not), so the search frame cannot change the answer.
      return searchDepths(this.cells, cellOfEnt(u, this.size), (c) => c === goal, this.costs.walk, false, Infinity, u.frame, null, this.bars[u.side]!, this.size) !== null;
    };
    if (u.plane === 'depths') {
      if (!walk(x, y)) ({ x, y } = this.defaultRally(u.side, 'depths'));
      if (!walk(x, y)) return;
      const goal = cellFor(u.frame, x, y, this.size);
      x = cellCentreX(goal, this.size);
      y = cellCentreY(goal, this.size);
    }
    const taken = this.claimedDiscs(u.side, u.plane, x, y, Infinity, [u]);
    let [tx, ty] = this.rallySlot(u.side, u.plane, u.radius, x, y, from, taken) ?? [x, y];
    if (u.plane === 'depths' && !walk(tx, ty)) [tx, ty] = [x, y];
    if (u.plane === 'surface') [tx, ty] = this.reachableNear(u, tx, ty);
    this.order(u, { k: 'move', x: tx, y: ty, fight, speed: 0 });
  }

  /** Centre of the nearest walkable surface cell (no cliff, no hole, no structure body) within `maxR` tiles of (x, y), or null. */
  openSurfaceNear(this: Sim, x: number, y: number, maxR: number, side: SideId = NEUTRAL, fromX = x, fromY = y): { x: number; y: number } | null {
    return this.surfaceCellNear(x, y, maxR, side, fromX, fromY, null);
  }

  /**
   * The nearest cell open in `nav`, as openSurfaceNear. `nav` null: the true ground (cliffs, holes, structure bodies);
   * an army's surfaceNav: the ground as it knows it (known footprints only), so a snapped intent goal never reveals an
   * unseen structure.
   */
  surfaceCellNear(this: Sim, x: number, y: number, maxR: number, side: SideId, fromX: number, fromY: number, nav: Uint8Array | null): { x: number; y: number } | null {
    // Search in the owner's frame so equal-distance cells resolve identically for rotated armies.
    const k = this.armyFrame[side]!;
    const size = this.size;
    // On the sign-symmetric position grid first: an offset point (x + 0.8) and its rotations then tie exactly.
    const qx = clampPos(x, size);
    const qy = clampPos(y, size);
    const lx = canonX(k, qx, qy, size);
    const ly = canonY(k, qx, qy, size);
    const c0 = cellOf(lx, ly, size);
    if (nav ? !nav[cellFor(k, x, y, size)] : !this.surfaceBlocked(side, x, y)) return { x: qx, y: qy };
    let best: { x: number; y: number } | null = null;
    let bd = maxR * maxR;
    let approach = Infinity;
    const fqx = clampPos(fromX, size);
    const fqy = clampPos(fromY, size);
    const fx = canonX(k, fqx, fqy, size);
    const fy = canonY(k, fqx, fqy, size);
    const cx = c0 % size;
    const cy = Math.floor(c0 / size);
    const r = Math.ceil(maxR);
    for (let yy = Math.max(0, cy - r); yy <= Math.min(this.size - 1, cy + r); yy++) {
      for (let xx = Math.max(0, cx - r); xx <= Math.min(this.size - 1, cx + r); xx++) {
        const c = yy * this.size + xx;
        const at = rotCell(k, c, size);
        if (nav ? nav[at] : this.block[at] || this.surfaceBodies[at]) continue;
        const d = sq(xx + 0.5 - lx) + sq(yy + 0.5 - ly);
        const near = sq(xx + 0.5 - fx) + sq(yy + 0.5 - fy);
        if (d < bd || (best !== null && d === bd && near < approach)) {
          approach = near;
          bd = d;
          best = { x: rotX(k, xx + 0.5, yy + 0.5, size), y: rotY(k, xx + 0.5, yy + 0.5, size) };
        }
      }
    }
    return best;
  }
}
