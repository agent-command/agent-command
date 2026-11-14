/** Depths designations: the cells an army marks for digging and the diggers assigned to them. */
import { CELL, isOpenCell, VISION_BITS_PER_WORD } from '../rules/contract.ts';
import { DESIGNATE_NORMAL, DESIGNATE_URGENT, designationAlternative, designationField } from '../nav/nav.ts';
import { GOAL_NONE, NAV_MOVING } from '../sim/constants.ts';
import { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import type { ArmyState } from '../sim/state.ts';
import { cellOfEnt } from '../util/grid.ts';

export class Designations {
  designateCell(this: Sim, t: ArmyState, c: number, priority: number): void {
    const previous = t.designations[c]!;
    if (previous === priority) return;
    const word = Math.floor(c / VISION_BITS_PER_WORD);
    const bit = 1 << c % VISION_BITS_PER_WORD;
    if (previous) {
      (previous === DESIGNATE_URGENT ? t.designationWords.urgent : t.designationWords.normal)[word]! &= ~bit;
      t.designationCount--;
    }
    if (priority) {
      (priority === DESIGNATE_URGENT ? t.designationWords.urgent : t.designationWords.normal)[word]! |= bit;
      t.designationCount++;
    }
    t.designations[c] = priority;
    t.designationDirty = true;
  }

  /** Fog refresh is the only authority for cancelling unknown tags: never consult hidden cells here. */
  refreshDesignations(this: Sim, t: ArmyState): void {
    const known = t.group.known;
    const gateKnown = t.group.gateKnown;
    for (let c = 0; c < this.n; c++) {
      const code = known[c]!;
      if (t.designations[c] && (isOpenCell(code) || code === CELL.bedrock || code === CELL.lode)) this.designateCell(t, c, 0);
      if (t.designationKnown[c] !== code || t.designationGate[c] !== gateKnown[c]) {
        t.designationKnown[c] = code;
        t.designationGate[c] = gateKnown[c]!;
        if (t.designationCount) t.designationDirty = true;
      }
    }
  }

  releaseDesignation(this: Sim, e: Ent): void {
    if (e.designation < 0) return;
    const t = this.armies[e.side]!;
    t.designationReserved[e.designation]!--;
    if (e.designationConnector >= 0) t.designationReserved[e.designationConnector]!--;
    t.designationRevision++;
    e.designation = -1;
    e.designationConnector = -1;
    e.path = null;
    e.navGoal = GOAL_NONE;
    e.progress = -1;
  }

  prepareDesignations(this: Sim): void {
    for (const army of this.allArmies) {
      const t = this.armies[army]!;
      if (t.designationDirty) {
        // Known gates, not hidden hostile structures, determine the shared work frontier.
        const bar = this.bars[army]!;
        designationField(t.group.known, t.designations, this.costs.walk, t.designationDistance, t.designationOwner, t.designationNext, t.designationVia, this.armyFrame[army]!, bar, undefined, Infinity, DESIGNATE_NORMAL, this.size);
        t.designationDirty = false;
        t.designationRevision++;
      }
    }
    for (const e of this.ents) {
      if (e.designation < 0) continue;
      const t = this.armies[e.side]!;
      if (e.dead || e.plane !== 'depths' || !t.designations[e.designation] || (e.order.k !== 'none' && (e.order.k !== 'mine' || !e.order.auto))) this.releaseDesignation(e);
    }
  }

  updateDesignation(this: Sim, e: Ent): boolean {
    const t = this.armies[e.side]!;
    if (!t.designationCount) return false;
    const here = cellOfEnt(e, this.size);
    const best = t.designationOwner[here]!;
    const current = e.designation;
    // Sticky normal work only yields when a reachable urgent frontier appears.
    const reconsider = current < 0 || (t.designations[current] === DESIGNATE_NORMAL && best >= 0 && t.designations[best] === DESIGNATE_URGENT);
    if (reconsider && (e.designationChecked !== t.designationRevision || e.designationCell !== here)) {
      let path: number[] | null = null;
      const via = best < 0 ? -1 : t.designationVia[best]!;
      // Reassigning this worker transfers its own reservation; a full shared connector must not block urgency.
      const goalWorkers = best < 0 ? Infinity : t.designationReserved[best]! - (best === current || best === e.designationConnector ? 1 : 0);
      const viaWorkers = via < 0 ? Infinity : t.designationReserved[via]! - (via === current || via === e.designationConnector ? 1 : 0);
      if (best >= 0 && goalWorkers < this.econ.designateWorkers && viaWorkers < this.econ.designateWorkers) {
        path = [];
        for (let c = here; c !== best;) {
          c = t.designationNext[c]!;
          if (c < 0) { path = null; break; }
          path.push(c);
        }
      } else if (best >= 0) {
        // Work theft when the nearest job is full: only on assignment/release/topology changes, not per tick.
        const bar = this.bars[e.side]!;
        path = designationAlternative(t.group.known, t.designations, this.costs.walk, here, e.frame, bar, t.designationReserved, this.econ.designateWorkers, current < 0 ? DESIGNATE_NORMAL : DESIGNATE_URGENT, current, e.designationConnector, this.size);
      }
      if (path && path.length) {
        this.releaseDesignation(e);
        e.designation = path[path.length - 1]!;
        t.designationReserved[e.designation]!++;
        const via = t.designationVia[e.designation]!;
        e.designationConnector = via === e.designation ? -1 : via;
        if (e.designationConnector >= 0) t.designationReserved[e.designationConnector]!++;
        t.designationRevision++;
        e.path = path;
        e.pathI = 0;
        e.navGoal = e.designation;
        e.workT = 0;
      }
      e.designationChecked = t.designationRevision;
      e.designationCell = here;
    }
    if (e.designation < 0) return false;
    // Only the tag and its one chosen corner connector authorize digging; changed approach walls do not.
    const next = e.path?.[e.pathI];
    const r = this.followDepths(e, next === e.designation || (e.designationConnector >= 0 && next === e.designationConnector));
    if (r !== NAV_MOVING) {
      this.releaseDesignation(e);
      e.designationChecked = t.designationRevision;
      e.designationCell = here;
    } else if (e.state !== 'digging') e.state = 'moving';
    return true;
  }
}
