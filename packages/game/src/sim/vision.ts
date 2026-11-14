/** Fog and vision: per-group bit-plane visibility stamping, scans, cloak detection and the `sees` queries every fog-safe read goes through. */
import { CELL, footprint, isIslandStructure, isNeutralKind, isStatKind, type Kind, type Plane, sunHalfWidth, surfaceFeature, SURFACE } from '../rules/contract.ts';
import { LineOfSight, revealDepths } from '../nav/nav.ts';
import { gatesOpen, inChamber, sightBlocked, wallBlocks } from '../rules/derelict.ts';
import { cellCentreX, cellCentreY, cellFor, cellOf, cellOfEnt } from '../util/grid.ts';
import { norm2, sq, TAU } from '../util/math.ts';
import { type Army, canonCell, isArmy, rotCell } from '../util/teams.ts';
import { MAX_BODY_RADIUS, PLANE_INDEX, SAPPER_PRUNE_EVERY, SAPPER_REALERT } from './constants.ts';
import { Ent } from './ent.ts';
import type { Sim } from './sim.ts';
import type { OreCache } from './state.ts';

/** Sim.cacheSight bits. */
export const CACHE_SURFACE = 1;
export const CACHE_DEPTHS = 2;

/**
 * OR `bit` into every cell whose row centre is within r of (x, y) and whose span overlaps the disc's chord on that row
 * by a positive length: a chord ending exactly on a cell edge marks neither cell beyond it, since floor() would take
 * the cell right of the edge but not its mirror left of the mirrored edge. Rows are those of frame `frame & 1`
 * (world rows, or world columns for quarter-turned frames): the point mirror maps rows onto rows exactly on the
 * sign-symmetric grid, and frame 1 sees a quarter-turned disc with frame 0's arithmetic, so the marked set rotates
 * with the stamping army (DESIGN §15.4).
 * With `los` (surface sight from low ground, standing in cell `from`): cliffs block it and high ground stays hidden.
 */
function stamp(v: Uint8Array, bit: number, frame: number, x: number, y: number, r: number, los: LineOfSight | null, from: number, terrain: Uint8Array | null, storms: Uint32Array | null, sourceStorms: number, size: number): void {
  const odd = (frame & 1) === 1;
  // Frame-1 coordinates are (y, size − x); its cell (u, w) is world cell u · size + size − 1 − w.
  const px = odd ? y : x;
  const py = odd ? size - x : y;
  const step = odd ? size : 1;
  const y0 = Math.max(0, Math.floor(py - r));
  const y1 = Math.min(size - 1, Math.floor(py + r));
  for (let row = y0; row <= y1; row++) {
    const dy = row + 0.5 - py;
    const half2 = r * r - dy * dy;
    if (half2 < 0) continue;
    const half = Math.sqrt(half2);
    const base = odd ? size - 1 - row : row * size;
    const end = base + Math.min(size - 1, Math.ceil(px + half) - 1) * step;
    const start = base + Math.max(0, Math.floor(px - half)) * step;
    if (storms !== null) {
      for (let i = start; i <= end; i += step) if (!storms[i] || (storms[i]! & sourceStorms)) v[i]! |= bit;
    } else if (los === null) {
      // Unoccluded vision fills the entire span. These spans are short: direct writes avoid both the per-cell
      // visibility branch and typed-array call overhead. The LoS path keeps deduplication to skip ray queries.
      for (let i = start; i <= end; i += step) v[i]! |= bit;
    } else los.stamp(v, terrain!, from, start, end, bit, step);
  }
}

export class SimVision {
  /** Is (x, y) inside an active scan of `army`'s vision group? */
  scanned(this: Sim, army: Army, x: number, y: number): boolean {
    for (const member of this.armies[army]!.group.armies) {
      for (const scan of this.armies[member]!.scans) {
        if (scan.until >= this.tick && norm2(x - scan.x, y - scan.y) <= sq(this.econ.scanRadius)) return true;
      }
    }
    return false;
  }

  /**
   * Can `army` currently see `e`? Its own (and allied) entities, islands, forward posts and falling payloads are always seen. Surface
   * units in a forest also need to be spotted (see seesCell).
   */
  sees(this: Sim, army: Army, e: Ent): boolean {
    if (isArmy(e.side) && !this.hostile(army, e.side) && !this.payloads[e.kind]) return true;
    if (e.hangar) return false;
    if (e.kind === 'island' || e.kind === 'post') return true;
    if (this.payloads[e.kind] && e.state === 'falling') return true;
    if (e.cloaked && e.plane === 'orbit' && !this.lit(e.x, e.y)) return this.detectsCloak(army, e);
    // An island is public, and so is what stands in its slot unless a storm hides it. An army capturing the island
    // has landed on it and sees its slot even in a storm (that structure sets the capture's pace, which it follows).
    const island = e.structure && e.plane === 'sky' ? this.alive(e.link) : undefined;
    if (island?.kind === 'island' && island.capSide === army && island.capT > 0) return true;
    if (e.plane === 'sky' && !this.skyVisible(army, e.x, e.y, this.stormMaskOf(e))) return false;
    if (island?.kind === 'island') return true;
    // The climb advertises its column to defenders on either endpoint plane, without making it globally public.
    if (e.transitAt > this.tick && e.transitKind?.telegraph !== 'none' && e.transitKind && (this.seesCell(army, e.transitKind.from, cellOfEnt(e, this.size)) || this.seesCell(army, e.transitKind.to, cellOfEnt(e, this.size)))) return true;
    if (e.structure) return this.footprintSeen(army, e.kind, e.plane, e.x, e.y);
    if (e.unit) return this.seesCell(army, e.plane, cellOfEnt(e, this.size)) || (e.plane === 'surface' && this.spireSenses(army, e));
    // Neutral bodies (rocks, the derelict core at the map centre's cell corner) take the cell in the viewer's frame,
    // so rotated armies see a point on a cell edge alike.
    return (this.vis[PLANE_INDEX[e.plane]]![cellFor(this.armyFrame[army]!, e.x, e.y, this.size)]! & this.armies[army]!.group.bit) !== 0;
  }

  /** Seeing any occupied cell reveals the body, without consulting terrain hidden behind it. */
  footprintSeen(this: Sim, army: Army, kind: Kind, plane: Plane, x: number, y: number): boolean {
    const f = isStatKind(kind) ? this.stats[kind].footprint : undefined;
    const vis = this.vis[PLANE_INDEX[plane]]!;
    const bit = this.armies[army]!.group.bit;
    if (!f) return (vis[cellOf(x, y, this.size)]! & bit) !== 0;
    for (let yy = Math.max(0, Math.floor(y - f.h / 2)); yy < Math.min(this.size, Math.ceil(y + f.h / 2)); yy++) {
      for (let xx = Math.max(0, Math.floor(x - f.w / 2)); xx < Math.min(this.size, Math.ceil(x + f.w / 2)); xx++) if (vis[yy * this.size + xx]! & bit) return true;
    }
    return false;
  }

  /**
   * A living Surface Spire segment of `army`'s vision group senses hostile Surface unit `e` within its beam reach
   * (spire.range + body radius from the footprint edge, squared: exact under every turn), past its sight disc, cliffs
   * and forests: a sieged tank capped at siegeSpireRange ≤ spire.range can never shell it unseen (DESIGN §4.2 Siege).
   */
  spireSenses(this: Sim, army: Army, e: Ent): boolean {
    for (const a of this.armies[army]!.group.armies) {
      const segment = this.armies[a]!.spire.surface;
      if (segment.hp > 0 && !segment.dead && !this.beyondFootprint(segment, e.x, e.y, this.stat(segment).range + e.radius)) return true;
    }
    return false;
  }

  /** Cloak detection is entity-specific: a visible cell alone never reveals its hidden occupant. */
  detectsCloak(this: Sim, army: Army, e: Ent): boolean {
    if ((isArmy(e.side) && !this.hostile(army, e.side)) || this.scanned(army, e.x, e.y)) return true;
    for (const source of this.ents) {
      if (source.dead || source.hp <= 0 || !source.built || source.hangar || source.transitKind?.stationary
        || !isArmy(source.side) || this.hostile(army, source.side) || source.plane !== 'orbit' || (!source.unit && source.kind !== 'spire')) continue;
      // Detection is sight: it obeys the ruin's walls and, like vision, the chamber's rule (stampOrbit).
      if (!this.orbitSightClear(source.x, source.y, e.x, e.y)) continue;
      // The segment detects out to its beam reach, measured from its footprint edge like the beam itself.
      if (source.kind === 'spire') {
        if (this.beyondFootprint(source, e.x, e.y, this.stat(source).range + e.radius)) continue;
        return true;
      }
      const radius = source.kind === 'bastion' ? this.stat(source).range : this.econ.cloakDetectRadius;
      if (sq(source.x - e.x) + sq(source.y - e.y) <= radius * radius) return true;
    }
    return false;
  }

  /**
   * Orbit sight between two points as stampOrbit grants it. With orbit.derelictBlocksVision the ruin's walls block it
   * exactly where they block fire (wallBlocks), so the chamber is seen from outside only along an open gate's line;
   * without, sight passes the walls and the chamber is hidden from outside entirely.
   */
  orbitSightClear(this: Sim, ax: number, ay: number, bx: number, by: number): boolean {
    const g = this.derelict;
    if (!g) return true;
    if (this.econ.derelictBlocksVision) return !wallBlocks(g, gatesOpen(g, this.tick), ax - g.x, ay - g.y, bx - g.x, by - g.y);
    return !inChamber(g, bx - g.x, by - g.y) || inChamber(g, ax - g.x, ay - g.y);
  }

  /** Is (x, y) more than `r` tiles from the footprint edge of structure `e`? Squared, so exact under every turn. */
  beyondFootprint(this: Sim, e: Ent, x: number, y: number, r: number): boolean {
    const f = footprint(e.kind)!;
    const ex = Math.max(0, Math.abs(x - e.x) - f.w / 2);
    const ey = Math.max(0, Math.abs(y - e.y) - f.h / 2);
    return ex * ex + ey * ey > r * r;
  }

  /**
   * The Orbit segment's own night sensor at (x, y): vision × nightSignature from its centre, floored at its beam range
   * (`spire.range`) from its footprint edge, so ships cannot shell it from the dark inside its beam (stampOrbit agrees).
   */
  segmentSenses(this: Sim, e: Ent, x: number, y: number): boolean {
    const r = this.stat(e).vision * this.econ.nightSignature;
    return sq(x - e.x) + sq(y - e.y) <= r * r || !this.beyondFootprint(e, x, y, this.stat(e).range);
  }

  /**
   * Can `army` see what happens in cell `c` on `plane` now? In a surface forest it also has to be spotted: an own
   * surface unit/structure within econ.forestSpot, Sky surface vision or a scan.
   */
  seesCell(this: Sim, army: Army, plane: Plane, c: number): boolean {
    const bit = this.armies[army]!.group.bit;
    return (this.vis[PLANE_INDEX[plane]]![c]! & bit) !== 0 && (plane !== 'surface' || surfaceFeature(this.terrain[c]!) !== SURFACE.forest || (this.spot[c]! & bit) !== 0)
      && (plane !== 'sky' || this.skyVisible(army, cellCentreX(c, this.size), cellCentreY(c, this.size)));
  }

  /** Which of ore cache `cache`'s heaps `army` sees now: CACHE_SURFACE (placed, its cell seen), CACHE_DEPTHS (alloy below, seen). */
  cacheSight(this: Sim, army: Army, cache: OreCache): number {
    return (cache.placed && this.seesCell(army, 'surface', cellOf(cache.x, cache.y, this.size)) ? CACHE_SURFACE : 0)
      | (cache.belowAlloy > 0 && this.seesCell(army, 'depths', cellOf(cache.belowX, cache.belowY, this.size)) ? CACHE_DEPTHS : 0);
  }

  /** Orbital scan: radius econ.scanRadius on every plane for econ.scanTicks. Takes effect immediately (refreshVision). */
  scan(this: Sim, army: Army, x: number, y: number): void {
    const t = this.armies[army]!;
    if (!this.spend(army, 0, this.econ.scanCost, 'orbit')) return;
    t.scanReadyAt = this.tick + this.econ.scanCooldownTicks;
    t.scans.push({ x, y, until: this.tick + this.econ.scanTicks });
    this.fxAdd('scan', 'orbit', x, y, army, false, { side: army });
    this.refreshVision();
  }

  /**
   * Vision now, or, inside `round`, once every seat's intents of the decision round have applied (same tick): a refresh
   * between two seats would show the later seat the earlier seats' same-round effects (a Warden's new shield wall in
   * its planner) and never the other way round.
   */
  refreshVision(this: Sim): void {
    if (this.inRound) this.roundVision = true;
    else this.computeVision();
  }

  /**
   * Darkness shortens detection rather than hiding ships outright; ORs `bit` into `vis`. Scans stamp their full radius
   * separately. Per-cell disc test on cell centres: exact under every quarter turn. `segment`: the Orbit Spire segment
   * stamping, whose sensor never falls short of its beam range from the footprint edge, lit or dark (segmentSenses).
   * With orbit.derelictBlocksVision a cell is seen only along a line to its centre that the ruin's walls do not block
   * (sightBlocked: the hull outside its breaches, the ring outside its gates while open and everywhere while sealed), so
   * the chamber is seen from outside only along an open gate's line, as fire reaches it. Without the rule the chamber
   * is a mask instead: only sources inside it (`inside`) and scans, stamped elsewhere, see in.
   */
  stampOrbit(this: Sim, vis: Uint8Array, bit: number, x: number, y: number, radius: number, segment: Ent | null, inside = false): void {
    const g = this.derelict;
    const occlude = g !== null && this.econ.derelictBlocksVision;
    const chamber = inside || occlude || !g ? null : this.chamberCells;
    const dark = this.orbitDark;
    const litRadius2 = radius * radius;
    const darkRadius2 = litRadius2 * this.econ.nightSignature * this.econ.nightSignature;
    const floor = segment ? this.stat(segment).range : 0;
    const box = Math.max(radius, segment ? footprint(segment.kind)!.w / 2 + floor : 0);
    // Every stamped cell centre lies within `reach` of the source, so a segment to one can cross a wall's mid circle
    // only when the source stands within `reach` of it; and never when both ends lie inside that circle. Both tests
    // only skip segments sightBlocked would pass.
    const ax = g ? x - g.x : 0;
    const ay = g ? y - g.y : 0;
    const reach = (box + 0.5) * Math.SQRT2;
    const a2 = ax * ax + ay * ay;
    const d = Math.sqrt(a2);
    const hullMid = g ? (g.hullInner + g.hullOuter) / 2 : 0;
    const ringMid = g ? (g.ringInner + g.ringOuter) / 2 : 0;
    const hull = occlude && Math.abs(d - hullMid) <= reach;
    const ring = occlude && Math.abs(d - ringMid) <= reach;
    const hull2 = hullMid * hullMid;
    const ring2 = ringMid * ringMid;
    const open = (hull || ring) && gatesOpen(g!, this.tick);
    const x0 = Math.max(0, Math.floor(x - box));
    const x1 = Math.min(this.size, Math.ceil(x + box));
    for (let yy = Math.max(0, Math.floor(y - box)); yy < Math.min(this.size, Math.ceil(y + box)); yy++) {
      const dy = yy + 0.5 - y;
      const dy2 = dy * dy;
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx + 0.5 - x;
        const c = yy * this.size + xx;
        if (chamber && chamber[c]) continue;
        if (dx * dx + dy2 > (dark[c] ? darkRadius2 : litRadius2) && !(segment && !this.beyondFootprint(segment, xx + 0.5, yy + 0.5, floor))) continue;
        if (hull || ring) {
          const bx = xx + 0.5 - g!.x;
          const by = yy + 0.5 - g!.y;
          const b2 = bx * bx + by * by;
          if (sightBlocked(g!, open, hull && (a2 >= hull2 || b2 >= hull2), ring && (a2 >= ring2 || b2 >= ring2), ax, ay, bx, by)) continue;
        }
        vis[c]! |= bit;
      }
    }
  }

  /**
   * Depths vision from cell `c` of `army` (a tunnel flood). Units sharing a cell need only the largest flood; the
   * dedupe is per army because gate passability is.
   */
  floodVision(this: Sim, army: Army, c: number, r: number): void {
    const k = army * this.n + c;
    if (this.stamped[k]! > r) return;
    this.stamped[k] = r + 1;
    revealDepths(this.cells, c, r, this.vis[PLANE_INDEX.depths]!, this.gate, this.gateBit(army), this.size, this.armies[army]!.group.bit);
  }

  /** This tick's orbit dark mask, then every entity's sight stamped into the bit-planes (one bit per vision group). */
  stampVision(this: Sim): void {
    this.weather.refreshMask();
    const size = this.size;
    const sun = this.sunAngle;
    // Darkness of the canonical sector, folded by the wedge period; each rotated twin takes it (exactly symmetric).
    const period = TAU / this.sunWedges;
    const halfWidth = sunHalfWidth(this.sunWedges);
    const sectorWidth = this.sides === 2 ? size : size / 2;
    const bearing = this.orbitCellBearing;
    for (let i = 0, row = 0, col = 0; i < bearing.length; i++) {
      const d = bearing[i]! - sun;
      const dark = Math.abs(d - period * Math.round(d / period)) < halfWidth ? 0 : 1;
      const c = row * size + col;
      for (let r = 0; r < this.sides; r++) this.orbitDark[rotCell(r * this.slotStep, c, size)] = dark;
      if (++col === sectorWidth) {
        col = 0;
        row++;
      }
    }
    for (const v of this.vis) v.fill(0);
    this.feel.fill(0);
    this.spot.fill(0);
    this.stamped.fill(0);
    const vis = this.vis;
    for (const e of this.ents) {
      if (e.dead || e.hangar > 0 || !isArmy(e.side) || e.kind === 'island' || e.kind === 'asteroid') continue;
      const t = this.armies[e.side]!;
      const bit = t.group.bit;
      const frame = e.frame;
      if (e.kind === 'post') {
        // A held forward post sees like a unit on high ground: over cliffs and onto plateaus, with no line-of-sight
        // mask, and spots into forests as close as any Surface unit would.
        stamp(vis[PLANE_INDEX.surface]!, bit, frame, e.x, e.y, this.econ.postVision, null, 0, null, null, 0, size);
        stamp(this.spot, bit, frame, e.x, e.y, this.econ.forestSpot, null, 0, null, null, 0, size);
        continue;
      }
      const visionScale = e.plane === 'sky' && this.weather.fogAt(e.x, e.y) ? this.econ.fogVision
        : e.plane === 'orbit' && e.unit && !this.lit(e.x, e.y) ? this.econ.nightVision : 1;
      const r = this.stat(e).vision * visionScale + this.deployVision(e);
      if (e.plane === 'depths') {
        this.floodVision(e.side, cellOfEnt(e, size), r);
        continue;
      }
      if (e.plane === 'surface') {
        stamp(this.feel, bit, frame, e.x, e.y, this.econ.tremorRadius, null, 0, null, null, 0, size);
        stamp(this.spot, bit, frame, e.x, e.y, this.econ.forestSpot, null, 0, null, null, 0, size);
        // Surface sight: cliffs block it from low ground; high ground sees over them and is only seen from high
        // ground (or from the sky / a scan).
        const high = this.onHigh(e);
        stamp(vis[PLANE_INDEX.surface]!, bit, frame, e.x, e.y, r + (high ? this.econ.highVision : 0), high ? null : this.los, cellOfEnt(e, size), this.terrain, null, 0, size);
      }
      if ((e.kind === 'shaft' || e.kind === 'headframe') && e.built) this.floodVision(e.side, cellOfEnt(e, size), this.econ.shaftDepthsVision);
      if (isIslandStructure(e.kind) && !e.built) continue;
      if (e.plane === 'sky') stamp(vis[PLANE_INDEX.sky]!, bit, frame, e.x, e.y, r, null, 0, null, this.weather.mask, this.weather.stormMask(e.x, e.y), size);
      else if (e.plane === 'orbit') this.stampOrbit(vis[PLANE_INDEX.orbit]!, bit, e.x, e.y, r, e.kind === 'spire' ? e : null, this.derelict !== null && inChamber(this.derelict, e.x - this.derelict.x, e.y - this.derelict.y));
      else if (e.plane !== 'surface') stamp(vis[PLANE_INDEX[e.plane]]!, bit, frame, e.x, e.y, r, null, 0, null, null, 0, size);
      // Units that can shoot into a neighbouring plane can also see into it, but not through storms.
      if (e.kind === 'flak' || e.kind === 'turret') stamp(vis[PLANE_INDEX.sky]!, bit, frame, e.x, e.y, r, null, 0, null, this.weather.mask, 0, size);
      // A Lens sees the Sky column it beams: lensReach to the edge of the largest body, so that body's cell is covered.
      else if (e.plane === 'orbit' && !e.transitKind && this.capable(e, 'lens')) stamp(vis[PLANE_INDEX.sky]!, bit, frame, e.x, e.y, this.econ.lensReach + MAX_BODY_RADIUS, null, 0, null, this.weather.mask, 0, size);
      else if (this.capable(e, 'spotterDown')) {
        const radius = (e.structure ? this.econ.relaySurfaceVision : this.econ.spotterDownVision) * visionScale;
        const below = PLANE_INDEX[e.plane] - 1;
        if (below === PLANE_INDEX.sky) stamp(vis[below]!, bit, frame, e.x, e.y, radius, null, 0, null, this.weather.mask, 0, size);
        else if (below >= 0) stamp(vis[below]!, bit, frame, e.x, e.y, radius, null, 0, null, null, 0, size);
        if (below === PLANE_INDEX.surface) stamp(this.spot, bit, frame, e.x, e.y, radius, null, 0, null, null, 0, size);
      }
    }
    this.stampFlares();
  }

  computeVision(this: Sim): void {
    this.stampVision();
    const size = this.size;
    const dv = this.vis[PLANE_INDEX.depths]!;
    for (const g of this.groups) {
      const bit = g.bit;
      // Group-wide reads decide through its first member (allies share colour, so hostility and sight agree).
      const lead = g.armies[0]!;
      for (const army of g.armies) {
        const t = this.armies[army]!;
        const frame = this.armyFrame[army]!;
        if (t.scans.length) t.scans = t.scans.filter((sc) => sc.until >= this.tick);
        for (const sc of t.scans) {
          for (const v of this.vis) stamp(v, bit, frame, sc.x, sc.y, this.econ.scanRadius, null, 0, null, null, 0, size);
          stamp(this.spot, bit, frame, sc.x, sc.y, this.econ.scanRadius, null, 0, null, null, 0, size);
          // Scans locate hidden magma pockets in the depths.
          for (let c = 0; c < this.n; c++) if (this.magma[c] && norm2(cellCentreX(c, size) - sc.x, cellCentreY(c, size) - sc.y) <= sq(this.econ.scanRadius)) g.pocketKnown[c] = this.magma[c]!;
        }
      }
      const known = g.known;
      for (let c = 0; c < this.n; c++) if (dv[c]! & bit) {
        if (!this.magma[c]) g.pocketKnown[c] = 0;
        const code = g.pocketKnown[c] ? CELL.magma : this.cells[c]!;
        if (known[c] !== code) { known[c] = code; g.knownAt[c] = this.tick; }
      }
      this.refreshCracks(lead);
      for (const l of this.lodes) if (this.footprintSeen(lead, 'headframe', 'surface', cellCentreX(l.c, size), cellCentreY(l.c, size))) this.learnLode(l, lead);
      // Locate floods by the group's own coordinate order (row-major in its lead's frame), not flood traversal order
      // (which encodes the hidden origin).
      const frame = this.armyFrame[lead]!;
      for (const f of this.floods) {
        if (f.knownAt[g.id]! >= 0) continue;
        let at = -1;
        let atKey = 0;
        for (const c of f.cells) {
          if (!(dv[c]! & bit)) continue;
          const key = canonCell(frame, c, size);
          if (at < 0 || key < atKey) {
            at = c;
            atKey = key;
          }
        }
        f.knownAt[g.id] = at;
      }
      for (const e of this.ents) {
        if (e.kind !== 'sapper' || !this.hostile(lead, e.side) || e.dead || e.plane !== 'depths' || !(dv[cellOfEnt(e, size)]! & bit)) continue;
        const last = g.sapperSeen.get(e.id);
        if (last === undefined || this.tick - last > SAPPER_REALERT) this.emit(g.armies, 'enemy_sapper_seen', 'depths', e.x, e.y, 'sapper', e.side);
        g.sapperSeen.set(e.id, this.tick);
      }
      if (this.tick % SAPPER_PRUNE_EVERY === 0) for (const [id] of g.sapperSeen) if (!this.alive(id)) g.sapperSeen.delete(id);
      // Forget a remembered body only once one of its occupied cells is seen empty.
      for (const [id, ghost] of g.memory) {
        const e = this.alive(id);
        if (e && this.sees(lead, e)) continue;
        if (this.footprintSeen(lead, ghost.kind, ghost.plane, ghost.x, ghost.y) && (ghost.plane !== 'sky' || this.skyVisible(lead, ghost.x, ghost.y))) g.memory.delete(id);
      }
      for (const e of this.ents) {
        if (e.dead || !this.hostile(lead, e.side) || !this.isStructure(e) || !this.sees(lead, e)) continue;
        g.memory.set(e.id, { kind: e.kind, side: e.side, plane: e.plane, x: e.x, y: e.y, seen: this.tick, ...(e.plane === 'sky' ? { elevation: e.elevation } : {}) });
      }
      this.knownGate(lead, g.gateKnown);
      for (const army of g.armies) {
        this.refreshDesignations(this.armies[army]!);
        this.refreshSurfaceFootprints(army);
      }
    }
    // Fresh vision: hidden charges a team now sees or feels, and intruders near each army's home.
    this.noticeCharges();
    this.watchIntruders();
    this.noteSightings();
    let researched = false;
    for (const t of this.armies) if (t.research.size !== 0) researched = true;
    if (!researched) return;
    for (const e of this.ents) {
      if (e.dead || !isArmy(e.side) || this.armies[e.side]!.research.size === 0) continue;
      this.revealEffect(e, 'unit', e.kind);
      if (this.modifierRows) this.revealEffect(e, 'modifier', 'hp');
    }
  }
}
