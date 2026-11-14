/**
 * Hold zones: the one capture rule Sky islands (DESIGN §4.3) and Surface forward posts (§4.2) share. A zone is a
 * neutral entity whose `side` is its holder (NEUTRAL when nobody holds it), `capSide`/`capT` the capture in progress
 * (army, ticks), `progress` its public share and `state` idle / capturing / contested. Each tick the zone's plane
 * counts every army's capturing units within its radius into `holders`, then calls zoneClaimant, advanceCapture,
 * applies its own side effects (structure drain, transfer, events) and finally settleCapture.
 */
import { MAX_ARMIES, type State } from '../rules/contract.ts';
import type { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import { isArmy, NEUTRAL, sectorOf, type SideId } from '../util/teams.ts';

/** Per-army scratch: capturing units in range of the zone being updated (filled and read within one zone's update). */
export const holders = new Int32Array(MAX_ARMIES);

/** advanceCapture: no capture advanced this tick (nobody, held, contested or fading). */
export const CAPTURE_IDLE = 0;
/** advanceCapture: an uncontested hostile claim advanced the capture one tick. */
export const CAPTURE_PROGRESS = 1;
/** advanceCapture: the capture is complete this tick; the caller transfers the zone to the claimant. */
export const CAPTURE_DONE = 2;

export class CaptureZones {
  /** The army claiming `zone` from this tick's `holders`: NEUTRAL unless exactly one alliance is present. */
  zoneClaimant(this: Sim, zone: Ent): SideId {
    let first: SideId = NEUTRAL;
    for (const army of this.allArmies) {
      if (holders[army] === 0) continue;
      if (first === NEUTRAL) first = army;
      else if (this.hostile(first, army)) return NEUTRAL;
    }
    if (first === NEUTRAL) return NEUTRAL;
    // Its army with the most holders claims it (ties: relative order from the zone's sector, so rotated situations
    // resolve rotated).
    const sector = sectorOf(zone.x, zone.y, this.size, this.sides);
    let holder: SideId = NEUTRAL;
    let order = 0;
    for (const army of this.allArmies) {
      if (holders[army] === 0) continue;
      const o = (this.armySlot[army]! - sector + this.sides) % this.sides;
      if (holder === NEUTRAL || holders[army]! > holders[holder]! || (holders[army] === holders[holder] && o < order)) {
        holder = army;
        order = o;
      }
    }
    return holder;
  }

  /** Is `holder` (this tick's claimant) the zone's holder or of its alliance? A neutral zone nobody claims counts as held. */
  zoneHeld(this: Sim, zone: Ent, holder: SideId): boolean {
    return holder === zone.side || (holder !== NEUTRAL && isArmy(zone.side) && !this.hostile(holder, zone.side));
  }

  /**
   * One tick of the hold rule for `zone`, given `holder` (zoneClaimant, NEUTRAL when nobody or hostile alliances
   * together are present) and `anyone` (some army has a holder there). An uncontested hostile claim advances the
   * capture (a new claimant restarts it) until `needed` ticks (CAPTURE_DONE). A held zone (and a neutral one nobody
   * uncontestedly claims, contested included) clears any capture in progress; a held zone left alone forgets one a
   * tick per tick; hostile alliances on a held zone together freeze it. `blocked` (a live defender the claimant must
   * destroy first, e.g. an island hardpoint Gun Platform) freezes a hostile claim the same way.
   */
  advanceCapture(this: Sim, zone: Ent, holder: SideId, anyone: boolean, needed: number, blocked = false): number {
    const held = this.zoneHeld(zone, holder);
    if (blocked && !held) return CAPTURE_IDLE;
    if (holder === NEUTRAL || held) {
      if (!anyone && zone.capT > 0) zone.capT--;
      if (held) zone.capT = 0;
      return CAPTURE_IDLE;
    }
    if (zone.capSide !== holder) {
      zone.capSide = holder;
      zone.capT = 0;
    }
    zone.capT++;
    return zone.capT >= needed ? CAPTURE_DONE : CAPTURE_PROGRESS;
  }

  /** `army` takes `zone` (the caller has already handled the previous holder): its capture resets. */
  takeZone(this: Sim, zone: Ent, army: SideId): void {
    this.setSide(zone, army);
    zone.capT = 0;
    zone.capSide = NEUTRAL;
  }

  /** The zone's public state and progress after this tick's update (`idle`: the zone kind's resting state). */
  settleCapture(this: Sim, zone: Ent, holder: SideId, anyone: boolean, needed: number, idle: State, blocked = false): void {
    zone.state = (anyone && holder === NEUTRAL) || blocked ? 'contested' : zone.capT > 0 && holder !== NEUTRAL && !this.zoneHeld(zone, holder) ? 'capturing' : idle;
    zone.progress = zone.capT > 0 ? Math.min(1, zone.capT / needed) : -1;
  }
}
