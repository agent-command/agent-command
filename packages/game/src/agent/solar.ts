import { bySeq, type Ent } from '../sim/ent.ts';
import { SNAP_EPS } from '../sim/constants.ts';
import type { Sim } from '../sim/sim.ts';
import { clampPos } from '../util/grid.ts';
import { BERTH_GAP, solarBerths } from '../util/solar-berths.ts';
import { canonX, canonY, rotX, rotY, type Army } from '../util/teams.ts';
import { norm } from '../util/math.ts';

/**
 * Bounded, home-first improvement, not a global packing optimum. Existing move goals are reservations, so
 * repeated clicks neither restart travel nor pack healthy deployments. Every new berth is unshaded against
 * the entire planned field (including arrays we cannot move); moving there cannot lower another array's yield.
 * Only own units, public geometry and visible bodies participate: hidden ships cannot change the result.
 */
export function spreadArrays(sim: Sim, team: Army, arrays: Ent[]): void {
  if (!arrays.length) return;
  const frame = sim.armyFrame[team]!;
  const size = sim.size;
  const ec = sim.econ;
  const home = sim.armies[team]!.spire.orbit;
  const point = (p: { x: number; y: number }): { x: number; y: number } => ({ x: canonX(frame, p.x, p.y, size), y: canonY(frame, p.x, p.y, size) });
  const centre = point(home);
  const field = sim.ents.filter(e => !e.dead && e.hp > 0 && e.side === team && e.plane === 'orbit' && e.kind === 'solar')
    .sort(bySeq).map(e => ({ e, ...point(e.order.k === 'move' ? e.order : e) }));
  const bodies = sim.claimedDiscs(team, 'orbit', home.x, home.y, Infinity, field.map(p => p.e)).map(p => ({ ...point(p), r: p.r }));
  for (const e of sim.ents) {
    if (e.dead || e.hangar || e.plane !== 'orbit' || e.structure) continue;
    if (e.side === team ? e.kind !== 'solar' && e.order.k !== 'none' && e.order.k !== 'move' : sim.sees(team, e)) bodies.push({ ...point(e), r: e.radius });
  }
  const ruin = sim.derelict ? sim.derelict.hullOuter + 2 : 0;
  const shadeRadius = ec.solarShadePer > 0 && ec.solarShadeFloor < 1 ? ec.solarShadeRadius : 0;
  const candidates = solarBerths(centre, size, shadeRadius, ruin, 2 * Math.max(...arrays.map(e => e.radius)) + ec.slotGap)
    .map(p => ({ x: clampPos(centre.x + p.x, size), y: clampPos(centre.y + p.y, size) }));
  const distance = (p: { x: number; y: number }): number => sim.solarDistance(rotX(frame, p.x, p.y, size), rotY(frame, p.x, p.y, size), home);
  const open = (p: { x: number; y: number }, e: Ent): boolean => sim.slotOpen(team, 'orbit', p.x, p.y, e.radius)
    && (!ruin || norm(p.x - size / 2, p.y - size / 2) >= ruin)
    && bodies.every(b => norm(p.x - b.x, p.y - b.y) >= b.r + e.radius + ec.slotGap);
  const separated = (p: { x: number; y: number }, e: Ent, margin: number): boolean => field.every(o => o.e === e
    || norm(p.x - o.x, p.y - o.y) >= Math.max(shadeRadius + margin, o.e.radius + e.radius + ec.slotGap) - SNAP_EPS);
  for (const e of arrays.sort(bySeq)) {
    const current = field.find(p => p.e === e)!;
    const legal = open(current, e) && separated(current, e, 0);
    if (legal && (e.order.k === 'move' || distance(current) === 1)) continue;
    let neighbours = 0;
    for (const o of field) if (o.e !== e && norm(current.x - o.x, current.y - o.y) < shadeRadius) neighbours++;
    let score = distance(current) * Math.max(ec.solarShadeFloor, 1 - neighbours * ec.solarShadePer);
    let best: { x: number; y: number } | undefined;
    let travel = Infinity;
    for (const p of candidates) {
      if (!open(p, e) || !separated(p, e, BERTH_GAP)) continue;
      const value = distance(p);
      const d = norm(p.x - current.x, p.y - current.y);
      if (value > score || (best && value === score && d < travel)) {
        best = p;
        score = value;
        travel = d;
      }
    }
    // No improving slot (including an overfull field): leave both position and order alone.
    if (!best) continue;
    current.x = best.x;
    current.y = best.y;
    sim.order(e, { k: 'move', x: rotX(frame, best.x, best.y, size), y: rotY(frame, best.x, best.y, size), fight: false, speed: 0 });
  }
}
