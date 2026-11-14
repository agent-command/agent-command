import { STATS, hostileSide, isOpenCell, isStatKind, type Entity, type View } from '@agent-command/game/contract';
import { spanYaw } from './common.ts';
import { STATE_VISUALS } from './models.ts';

export interface PresentationState { work: number; fill: number; target: number; yaw: number }
interface MotionSample { n: number; sx: ArrayLike<number>; sy: ArrayLike<number> }
const DX = [1, 0, -1, 0] as const, DY = [0, 1, 0, -1] as const;

/** Open neighbours in team knowledge only. Unknown rock never suggests an unseen passage. */
export function passageMask(cells: readonly number[], x: number, y: number, size: number): number {
  let mask = 0;
  x = Math.floor(x); y = Math.floor(y);
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d]!, ny = y + DY[d]!;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size && isOpenCell(cells[ny * size + nx] ?? 0)) mask |= 1 << d;
  }
  return mask;
}

/** A transverse gate, a diagonal bisector at a bend, or a four-sided junction enclosure. */
export function passagePose(mask: number, state: PresentationState): void {
  let a = -1, b = -1, count = 0;
  for (let d = 0; d < 4; d++) if (mask & (1 << d)) { if (a < 0) a = d; else b = d; count++; }
  state.fill = count >= 3 ? 1 : count === 2 && ((a + 2) % 4 !== b) ? 0.5 : 0;
  state.yaw = count >= 3 || count === 0 ? 0 : count === 1 ? Math.atan2(DY[a]!, DX[a]!) : Math.atan2(DY[a]! - DY[b]!, DX[a]! - DX[b]!);
}

/** Only a friendly, observed mobile body approaching/occupying this cell can open the leaves. */
export function passageOccupied(gate: Entity, view: View, tracks: ReadonlyMap<string, MotionSample>, wasOpen: boolean): boolean {
  if (gate.side === 'neutral' || !view.match || hostileSide(view.match, view.army, gate.side) || gate.state === 'constructing') return false;
  if (gate.kind === 'warden' && gate.state !== 'walled') return false;
  const gx = Math.floor(gate.x), gy = Math.floor(gate.y);
  for (const e of view.entities) {
    if (e.id === gate.id || e.side === 'neutral' || hostileSide(view.match, gate.side, e.side) || e.plane !== 'depths' || !isStatKind(e.kind) || STATS[e.kind].speed <= 0) continue;
    if (e.kind === 'warden' && (e.state === 'walling' || e.state === 'walled' || e.state === 'unwalling' || e.state === 'idle')) continue;
    const dx = gate.x - e.x, dy = gate.y - e.y;
    if (dx * dx + dy * dy > 0.7 * 0.7) continue;
    const cx = Math.floor(e.x), cy = Math.floor(e.y);
    if (Math.abs(cx - gx) + Math.abs(cy - gy) > 1) continue;
    if ((cx === gx && cy === gy) || wasOpen) return true;
    const tr = tracks.get(e.id);
    let vx = tr && tr.n >= 2 ? e.x - tr.sx[tr.n - 2]! : 0;
    let vy = tr && tr.n >= 2 ? e.y - tr.sy[tr.n - 2]! : 0;
    if (Math.abs(vx) + Math.abs(vy) < 0.001 && e.state !== 'idle' && e.tx !== undefined && e.ty !== undefined) { vx = e.tx - e.x; vy = e.ty - e.y; }
    if (vx * dx + vy * dy > 0.001) return true;
  }
  return false;
}

/** Ingest-derived pose and targets; interpolation is shared by every table-driven presentation channel. */
export class Presentations {
  private readonly states = new Map<string, PresentationState>();
  private readonly seen = new Set<string>();
  get(id: string): PresentationState | undefined { return this.states.get(id); }
  ingest(view: View, tracks: ReadonlyMap<string, MotionSample>): void {
    this.seen.clear();
    for (const e of view.entities) {
      const pose = STATE_VISUALS[e.kind]?.pose;
      if (!pose) continue;
      const state = this.observe(e, view);
      // A span never moves: only a gate opens for the traffic it admits.
      state.target = pose === 'passage' && passageOccupied(e, view, tracks, state.target > 0) ? 1 : 0;
      if (pose === 'span' || e.side === 'neutral' || hostileSide(view.match!, view.army, e.side)) state.work = 0;
    }
    for (const e of view.memory) {
      if (this.seen.has(e.id) || !STATE_VISUALS[e.kind]?.pose) continue;
      const state = this.observe(e, view);
      state.target = state.work = 0;
    }
    for (const id of this.states.keys()) if (!this.seen.has(id)) this.states.delete(id);
  }
  private observe(e: Pick<Entity, 'id' | 'kind' | 'x' | 'y'>, view: View): PresentationState {
    this.seen.add(e.id);
    let state = this.states.get(e.id);
    if (!state) { state = { work: 0, target: 0, fill: 0, yaw: 0 }; this.states.set(e.id, state); }
    const size = view.match!.rules.map.size;
    if (STATE_VISUALS[e.kind]?.pose === 'span') {
      state.fill = 0;
      state.yaw = spanYaw(view.depths, e.x, e.y, size);
    } else passagePose(passageMask(view.depths, e.x, e.y, size), state);
    return state;
  }
  frame(dt: number, reduced: boolean): void {
    for (const state of this.states.values()) {
      if (reduced) state.work = state.target;
      else {
        const delta = state.target - state.work;
        state.work += Math.sign(delta) * Math.min(Math.abs(delta), dt / 0.18);
      }
    }
  }
}
