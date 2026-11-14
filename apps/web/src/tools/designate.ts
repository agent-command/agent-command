import { CELL, UNITS_PER_INTENT, isDiggable, isOpenCell, type View } from '@agent-command/game/contract';
import type { Intent } from '../controls.ts';
import { digArea, digPriority, digRect, type DigRect } from '../designate.ts';
import { resolvePointer, type PlaneTool, type ToolContext, type ToolPointer } from './types.ts';

// Release-only scratch covers the largest map; searches use their own view's stride.
const seen = new Uint8Array(80 * 80);
const frontier = new Int32Array(80 * 80);
const gated = new Uint8Array(80 * 80);
const pocket = new Uint8Array(80 * 80);
const diggable = (code: number) => code === CELL.unknown || isDiggable(code);

/** Prefer the nearest box wall reachable on foot; otherwise tunnel toward the nearest reachable box cell. */
function boxTarget(view: View, start: number, rect: DigRect, tunnel: boolean): number {
  const size = view.match!.rules.map.size;
  seen.fill(0, 0, size * size);
  let head = 0, tail = 1;
  frontier[0] = start;
  seen[start] = 1;
  while (head < tail) {
    const cell = frontier[head++]!;
    const x = cell % size, y = Math.floor(cell / size);
    if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1 && diggable(view.depths[cell]!)) return cell;
    if (cell !== start && (!isOpenCell(view.depths[cell]!) || gated[cell]) && !tunnel) continue;
    // Discovered lode ore can be a destination, but cannot be a route to another cell.
    if (cell !== start && pocket[cell] && view.depths[cell] === CELL.ore) continue;
    for (let k = 0; k < 4; k++) {
      const next = k === 0 ? cell + 1 : k === 1 ? cell - 1 : k === 2 ? cell + size : cell - size;
      const nx = next % size, ny = Math.floor(next / size);
      // The rim is always bedrock, including when still unknown to the player.
      if (nx <= 0 || nx >= size - 1 || ny <= 0 || ny >= size - 1 || seen[next]) continue;
      const code = view.depths[next]!;
      if (!isOpenCell(code) && !diggable(code)) continue;
      if (!tunnel && gated[next]) continue;
      seen[next] = 1;
      frontier[tail++] = next;
    }
  }
  return -1;
}

/** One explicit destination per selected digger; no affinity survives these ordinary orders. */
function selectedDigs(c: ToolContext, rect: DigRect, view: View, intents: Intent[]): void {
  const size = view.match!.rules.map.size;
  if (!c.selection.units.some((unit) => unit.kind === 'digger')) return;
  pocket.fill(0, 0, size * size);
  // A lode's pocket is the eight cells around its discovered outcrop, excluding its shaft.
  for (const lode of view.lodes ?? []) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = lode.x + dx, y = lode.y + dy;
      if ((dx || dy) && x >= 0 && x < size && y >= 0 && y < size) pocket[y * size + x] = 1;
    }
  }
  gated.fill(0, 0, size * size);
  for (const entity of view.entities ?? []) {
    if (entity.kind === 'bulkhead' && entity.side !== view.army && entity.plane === 'depths')
      gated[Math.floor(entity.y) * size + Math.floor(entity.x)] = 1;
  }
  for (const unit of c.selection.units) {
    if (unit.kind !== 'digger') continue;
    const x = Math.floor(unit.x), y = Math.floor(unit.y);
    if (x <= 0 || x >= size - 1 || y <= 0 || y >= size - 1) continue;
    const start = y * size + x;
    let target = boxTarget(view, start, rect, false);
    if (target < 0) target = boxTarget(view, start, rect, true);
    if (target < 0) continue;
    const tx = target % size, ty = Math.floor(target / size);
    const group = intents.find((intent) => intent.kind === 'dig' && intent.x === tx && intent.y === ty && (intent.units as string[]).length < UNITS_PER_INTENT);
    if (group) (group.units as string[]).push(unit.id);
    else intents.push({ kind: 'dig', units: [unit.id], x: tx, y: ty });
  }
}

export function commitDesignation(c: ToolContext, p: ToolPointer, rect: DigRect | undefined, immediate = false): Intent[] {
  const view = c.host.view();
  const limit = view?.match?.rules?.depths.designateCells;
  if (!rect || !view || limit === undefined) return [];
  if (digArea(rect) > limit) {
    c.host.toast(`Dig box exceeds ${limit} cells; choose a smaller box`);
    return [];
  }
  const priority = digPriority(p);
  const intents: Intent[] = [{ kind: 'designate', rect, priority }];
  if (immediate && priority) selectedDigs(c, rect, view, intents);
  return intents;
}

/** Right-button state is separate from left selection and the persistent J tool. */
export function moveDesignationDrag(c: ToolContext, p: ToolPointer): void {
  const drag = c.state.rightDrag;
  if (!drag) return;
  const end = resolvePointer(c, p, { ground: true }).tile;
  drag.rect = end && digRect(drag.start, end, c.world.size);
  if (drag.rect && digArea(drag.rect) >= 2) drag.active = true;
  if (drag.active) {
    c.overlay.preview = undefined;
    c.world.pointAway();
    c.world.rig.edge.x = c.world.rig.edge.y = 0;
  }
}

export function previewDesignationDrag(c: ToolContext, p: ToolPointer): void {
  const drag = c.state.rightDrag;
  if (!drag?.active || c.world.rig.focus !== 'depths') return;
  const rect = drag.rect;
  const limit = c.host.view()?.match?.rules.depths.designateCells;
  c.world.designations.showPreview(rect, digPriority(p), limit !== undefined && !!rect && digArea(rect) <= limit);
}

export function resetDesignationDrag(c: ToolContext): void {
  c.state.rightDrag = undefined;
  c.world.designations.showPreview();
}
export function designationTool(meta: Pick<PlaneTool, 'id' | 'planes' | 'label' | 'hint' | 'hotkey' | 'cursor'>): PlaneTool {
  const preview = (c: ToolContext, p: ToolPointer) => {
    const end = resolvePointer(c, p, { ground: true }).tile;
    const start = c.state.start ?? resolvePointer(c, p).tile;
    const rect = start && end && digRect(start, end, c.world.size);
    const limit = c.host.view()?.match?.rules.depths.designateCells;
    const count = rect ? digArea(rect) : 0;
    c.overlay.preview = undefined;
    c.world.designations.showPreview(rect, digPriority(p), limit !== undefined && count <= limit);
    const hint = `${meta.hint}${rect ? ` · ${count}/${limit ?? '—'} cells${limit !== undefined && count > limit ? ' — box too large' : ''}` : ''}`;
    if (hint !== c.state.hint) {
      c.state.hint = hint;
      c.host.hint(hint);
    }
  };
  const commit: PlaneTool['commit'] = (c, p) => {
    const start = c.state.start;
    c.state.start = undefined;
    if (!start) return [];
    const end = resolvePointer(c, p, { ground: true }).tile;
    const rect = end && digRect(start, end, c.world.size);
    return commitDesignation(c, p, rect);
  };
  return {
    ...meta, persistent: true, capturesDrag: true, card: () => true,
    applies: () => true,
    role: () => 'depths',
    enter(c) {
      c.overlay.preview = undefined;
      c.world.pointAway();
      c.world.rig.edge.x = c.world.rig.edge.y = 0;
    },
    dragStart(c, p) { c.state.start = resolvePointer(c, p).tile; preview(c, p); },
    dragEnd(c, p) { const intents = commit(c, p); preview(c, p); return intents; },
    preview,
    leave(c) { if (!c.state.start) { c.state.pointer = undefined; c.world.designations.showPreview(); } },
    reset(c) { c.world.designations.showPreview(); c.host.hint(meta.hint); },
    commit,
  };
}
