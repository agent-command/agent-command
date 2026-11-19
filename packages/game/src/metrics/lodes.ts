/** Read-only lode economy and Headframe lifecycle measurements, shared by both comparison revisions. */
import type { ArmyId } from '../rules/contract.ts';
import { REFERENCE_MAP_SIZE } from '../maps/types.ts';
import { ACCOUNT_INCOME } from '../sim/constants.ts';
import type { Sim } from '../sim/sim.ts';
import { cellCentreX, cellCentreY } from '../util/grid.ts';
import { isArmy, rotX, rotY } from '../util/teams.ts';
import type { SimEvent } from '../sim/state.ts';
import { perArmy, type PerArmy } from './summary.ts';
import { norm } from '../util/math.ts';

/*
 * Flank classification is a measurement over fixed reference geometry (REFERENCE_MAP_SIZE tiles, scaled to the map:
 * bases near (8, 8) and its turns), not over the match's rules or Spire inset: both comparison revisions must
 * classify the same outcrops identically, so no rule moves these numbers. Tiles on the reference size.
 */
/** Near coordinate of a reference-layout corner (bases sit at (near, near) and its turns). */
const LAYOUT_NEAR = 8;
/** Far coordinate of a reference-layout corner (on two-slot maps the empty corners are (far, near) and (near, far)). */
const LAYOUT_FAR = 40;
/** A flank outcrop lies within this distance of a flank anchor... */
const FLANK_RADIUS = 9;
/** ...and its distances to the two nearest bases differ by at most this much. */
const FLANK_SKEW = 10;

export interface LodeSideMetrics {
  /** All earned alloy (ore deliveries, Spire and Headframe trickles), excluding starting stock and refunds. */
  earnedAlloy: number;
  /** Delivered pocket ore plus Headframe trickles, from the sim's cumulative counter. */
  lodeAlloy: number;
  headframesBuilt: number;
  headframesLost: number;
  flankBuilt: number;
  flankLost: number;
  flankSitesLost: number;
}

export interface LodeMetrics {
  /** Fixed geometry, not the map's rich flag: identical classification on both revisions. */
  outcrops: { x: number; y: number; rich: boolean; flank: boolean; loads: number }[];
  sides: PerArmy<LodeSideMetrics>;
}

/**
 * Flank region of a `sides`-slot map of `size`: within FLANK_RADIUS (scaled) of a flank anchor — the empty corners
 * of a two-slot map, the edge midpoints between neighbouring corners of a four-slot map — with the distances to the
 * two nearest bases differing by at most FLANK_SKEW (scaled). On S48 two-slot maps: near (40, 8) or (8, 40).
 */
export function isFlank(x: number, y: number, size: number, sides: number): boolean {
  const scale = size / REFERENCE_MAP_SIZE;
  const near = LAYOUT_NEAR * scale;
  const ax = sides === 2 ? LAYOUT_FAR * scale : size / 2;
  let anchor = Infinity;
  let first = Infinity;
  let second = Infinity;
  for (let k = 0; k < 4; k++) {
    if (sides === 2 ? k % 2 === 0 : true) anchor = Math.min(anchor, norm(x - rotX(k, ax, near, size), y - rotY(k, ax, near, size)));
    if (sides === 2 && k % 2 === 1) continue;
    const d = norm(x - rotX(k, near, near, size), y - rotY(k, near, near, size));
    if (d < first) [first, second] = [d, first];
    else if (d < second) second = d;
  }
  return anchor <= FLANK_RADIUS * scale && second - first <= FLANK_SKEW * scale;
}

const side = (): LodeSideMetrics => ({ earnedAlloy: 0, lodeAlloy: 0, headframesBuilt: 0, headframesLost: 0, flankBuilt: 0, flankLost: 0, flankSitesLost: 0 });

export class LodeRecorder {
  private readonly completed: PerArmy<Set<string>>;
  readonly metrics: LodeMetrics;
  private readonly sim: Sim;

  constructor(sim: Sim) {
    this.sim = sim;
    this.completed = perArmy(sim.armyIds, () => new Set<string>());
    this.metrics = {
      outcrops: sim.lodes.map((l) => {
        const x = cellCentreX(l.c, sim.size);
        const y = cellCentreY(l.c, sim.size);
        return { x, y, rich: l.rich, flank: isFlank(x, y, sim.size, sim.sides), loads: l.loads };
      }),
      sides: perArmy(sim.armyIds, side),
    };
  }

  collect(): void {
    for (const a of this.sim.allArmies) {
      const t = this.sim.armies[a]!;
      const m = this.metrics.sides[this.sim.armyIds[a]!]!;
      m.earnedAlloy = t.accounting[ACCOUNT_INCOME]!;
      m.lodeAlloy = t.stats.lodeAlloy;
    }
  }

  event(ev: SimEvent): void {
    if (ev.subject !== 'headframe' || ev.side === undefined || !isArmy(ev.side)) return;
    const army: ArmyId = this.sim.armyIds[ev.side]!;
    const x = Math.floor(ev.x);
    const y = Math.floor(ev.y);
    const key = `${x},${y}`;
    const m = this.metrics.sides[army]!;
    const completed = this.completed[army]!;
    const flank = isFlank(x + 0.5, y + 0.5, this.sim.size, this.sim.sides);
    if (ev.kind === 'constructed') {
      completed.add(key);
      m.headframesBuilt++;
      if (flank) m.flankBuilt++;
    } else if (ev.kind === 'structure_lost') {
      if (completed.delete(key)) {
        m.headframesLost++;
        if (flank) m.flankLost++;
      } else if (flank) m.flankSitesLost++;
    }
  }
}
