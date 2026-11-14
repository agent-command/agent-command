import { CELL, STATS, STRUCTURE_SPACING, VISION_BITS_PER_WORD, footprint, hostileSide, inBuildRadius, inEnemySpireZone, isOpenCell, isRadiusBound, radiusExempt, surfaceSiteLevel, type BuildSiteError, type Kind, type Plane, type StructureKind, type View } from '@agent-command/game/contract';
import type { MatchView } from './match-view.ts';
import { contestedPoints } from './post-tip.ts';
import type { Track } from './world/entities.ts';
import type { World } from './world/world.ts';

export interface FootprintCell { x: number; y: number; valid: boolean }
export interface PlacementFootprint {
  x: number; y: number; w: number; h: number;
  cells: FootprintCell[];
  /** Why the build radius refuses the whole site (every cell invalid), or null. */
  reason: BuildSiteError | null;
}

/**
 * The shared build rule (contract buildSiteError) for a Surface `kind` site centred at (x, y), judged on what the
 * army sees: its own live, completed structures and the public Spire positions of hostile armies still in play.
 * Null without a match bootstrap.
 */
export function placementRadius(view: Partial<Pick<MatchView, 'match'>> & Pick<View, 'army' | 'eliminated' | 'entities'>, kind: Kind, x: number, y: number): BuildSiteError | null {
  const match = view.match;
  if (!match) return null;
  const rules = match.rules.surface;
  for (const a of match.armies) {
    if (!hostileSide(match, view.army, a.id) || view.eliminated.includes(a.id)) continue;
    if (inEnemySpireZone(a.spireAt.x, a.spireAt.y, x, y, rules)) return 'no_build_zone';
  }
  if (radiusExempt(kind)) return null;
  const points = contestedPoints(match);
  for (const e of view.entities) {
    if (e.side === view.army && e.plane === 'surface' && e.state !== 'constructing' && e.hp > 0 && inBuildRadius(e.kind, e.x, e.y, x, y, rules, points.has(e.id))) return null;
  }
  return 'out_of_radius';
}

/** Intent coordinates are the minimum cell, while all observed entity/queue coordinates are centres. */
export function buildAnchor(kind: StructureKind, x: number, y: number, view?: View, out = { x: 0, y: 0 }): { x: number; y: number } {
  x = Math.floor(x); y = Math.floor(y);
  if (kind === 'headframe') {
    const f = footprint(kind)!;
    const lode = view?.lodes.find((l) => Math.abs(x - l.x) < f.w / 2 && Math.abs(y - l.y) < f.h / 2);
    if (lode) { x = lode.x + 0.5 - f.w / 2; y = lode.y + 0.5 - f.h / 2; }
  }
  out.x = x; out.y = y;
  return out;
}

/** A preview cell is always 1×1, independent of any structure kind's current registry dimensions. */
function cellOverlapsFootprint(cx: number, cy: number, kind: Kind, x: number, y: number, spacing: number): boolean {
  const f = footprint(kind);
  return !!f && Math.abs(cx + 0.5 - x) < (1 + f.w) / 2 + spacing && Math.abs(cy + 0.5 - y) < (1 + f.h) / 2 + spacing;
}

/** Advisory only: never consult the sim or infer hidden obstructions from public map symmetry. */
export function placementFootprint(kind: StructureKind, x: number, y: number, view: (View & Partial<Pick<MatchView, 'match'>>) | undefined, terrain: ArrayLike<number>, size: number, out?: PlacementFootprint): PlacementFootprint {
  const f = footprint(kind)!;
  const result: PlacementFootprint = out ?? { x: 0, y: 0, w: f.w, h: f.h, cells: [], reason: null };
  const anchor = buildAnchor(kind, x, y, view, result);
  result.w = f.w; result.h = f.h;
  const plane = STATS[kind].plane, cells = result.cells;
  cells.length = f.w * f.h;
  const lode = kind === 'headframe' && view?.lodes.find((l) => l.x + 0.5 === anchor.x + f.w / 2 && l.y + 0.5 === anchor.y + f.h / 2);
  // The whole site plus apron must share one level (all ground or all high), so terrain rejects every cell at once.
  const level = plane === 'surface' ? surfaceSiteLevel(terrain, size, anchor.x, anchor.y, f.w, f.h) : 0;
  result.reason = view && isRadiusBound(kind) ? placementRadius(view, kind, anchor.x + f.w / 2, anchor.y + f.h / 2) : null;
  for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) {
    const cx = anchor.x + dx, cy = anchor.y + dy, index = cy * size + cx;
    let valid = !!view && !result.reason && cx >= 0 && cy >= 0 && cx < size && cy < size
      && !!((view.vision[plane][Math.floor(index / VISION_BITS_PER_WORD)] ?? 0) & (1 << (index % VISION_BITS_PER_WORD)));
    if (valid && view) {
      if (plane === 'surface') {
        valid = level >= 0
          && !view.holes.some((h) => h.x === cx && h.y === cy)
          && (kind !== 'shaft' || view.depths[index] !== CELL.bedrock);
        if (kind === 'headframe') valid &&= !!lode;
        else valid &&= !view.lodes.some((l) => Math.abs(cx - l.x) < STATS.headframe.footprint.w / 2 && Math.abs(cy - l.y) < STATS.headframe.footprint.h / 2);
      } else if (plane === 'depths') {
        valid = view.depths[index] === CELL.tunnel && !view.holes.some((h) => h.x === cx && h.y === cy)
          && ((cx > 0 && isOpenCell(view.depths[index - 1] ?? CELL.unknown))
            || (cx + 1 < size && isOpenCell(view.depths[index + 1] ?? CELL.unknown))
            || (cy > 0 && isOpenCell(view.depths[index - size] ?? CELL.unknown))
            || (cy + 1 < size && isOpenCell(view.depths[index + size] ?? CELL.unknown)));
      }
      // A 1×1 footprint at this cell shares the same rectangular overlap/ring rule as the full site.
      const blocked = (other: { kind: Kind; plane: Plane; x: number; y: number }) => other.plane === plane
        && cellOverlapsFootprint(cx, cy, other.kind, other.x, other.y, plane === 'surface' ? STRUCTURE_SPACING : 0);
      valid &&= !view.entities.some(blocked) && !view.memory.some(blocked)
        && !view.queue.some((q) => q.x !== undefined && q.y !== undefined && q.item in STATS && q.plane === plane
          && cellOverlapsFootprint(cx, cy, q.item as Kind, q.x, q.y, plane === 'surface' ? STRUCTURE_SPACING : 0));
    }
    const cell = cells[dy * f.w + dx] ??= { x: cx, y: cy, valid };
    cell.x = cx; cell.y = cy; cell.valid = valid;
  }
  return result;
}

/** Projected corners in winding order. Shared by picking and drag-box intersection, not screen AABBs. */
export type FootprintQuad = Float64Array;
export function quadDistance(q: FootprintQuad, x: number, y: number): number {
  let positive = false, negative = false, distance = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, ax = q[i * 2]!, ay = q[i * 2 + 1]!, vx = q[j * 2]! - ax, vy = q[j * 2 + 1]! - ay;
    const cross = vx * (y - ay) - vy * (x - ax);
    positive ||= cross > 0; negative ||= cross < 0;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
    distance = Math.min(distance, Math.hypot(ax + t * vx - x, ay + t * vy - y));
  }
  return positive && negative ? distance : 0;
}

export function quadIntersectsBox(q: FootprintQuad, x0: number, y0: number, x1: number, y1: number): boolean {
  // Separating axes of both convex polygons: screen axes and each footprint edge normal.
  for (let axis = -2; axis < 4; axis++) {
    const j = (axis + 1) % 4;
    const nx = axis === -2 ? 1 : axis === -1 ? 0 : q[axis * 2 + 1]! - q[j * 2 + 1]!;
    const ny = axis === -2 ? 0 : axis === -1 ? 1 : q[j * 2]! - q[axis * 2]!;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 4; i++) { const p = nx * q[i * 2]! + ny * q[i * 2 + 1]!; lo = Math.min(lo, p); hi = Math.max(hi, p); }
    const b0 = Math.min(nx * x0, nx * x1) + Math.min(ny * y0, ny * y1);
    const b1 = Math.max(nx * x0, nx * x1) + Math.max(ny * y0, ny * y1);
    if (hi < b0 || lo > b1) return false;
  }
  return true;
}

/** Project the occupied ground/deck rectangle without allocating or using a model's decorative silhouette. */
export function projectFootprint(world: Pick<World, 'project' | 'size'>, tr: Track, out: FootprintQuad): FootprintQuad | undefined {
  const f = footprint(tr.e.kind);
  if (!f) return undefined;
  for (let i = 0; i < 4; i++) {
    const p = world.project(tr.rx + (i === 1 || i === 2 ? f.w / 2 : -f.w / 2) - world.size / 2,
      tr.wy + 0.04, tr.ry + (i >= 2 ? f.h / 2 : -f.h / 2) - world.size / 2);
    if (p.behind) return undefined;
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.y;
  }
  return out;
}
