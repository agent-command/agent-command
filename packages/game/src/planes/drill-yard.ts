/**
 * Surface Drill Yard (DESIGN §4.2 Drill Yard and Breacher): own Troopers ordered in (`convert`) walk to the yard and
 * come out Breachers, one at a time per yard. The Trooper inside is housed (`hangar` = the yard): hidden from enemies,
 * out of combat, unable to act. The conversion's cost and time are the `breacher` stats row (alloy, energy, build).
 */
import { isArmy } from '../util/teams.ts';
import { cellOfEnt } from '../util/grid.ts';
import { type Ent, NONE } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';

/** Mixed into Sim. */
export class DrillYards {
  /** Own live Drill Yards, sites included (the rules.surface.drillYardMax count). */
  drillYards(this: Sim, army: number): number {
    let n = 0;
    for (const e of this.ents) if (!e.dead && e.hp > 0 && e.kind === 'drill_yard' && e.side === army) n++;
    return n;
  }

  /**
   * Each tick, after production. A Trooper inside a yard that is gone (destroyed, or no longer its army's) steps out
   * a Trooper and idle: the paid conversion is lost. A working yard advances its conversion and swaps the Trooper for
   * a Breacher when done. An idle built yard takes in its next arrived Trooper, the lowest serial (rotation-exact),
   * once the army can pay the conversion; until then the line waits. Yard fields: `link` the Trooper inside, `workT`
   * ticks of work, `progress` 0..1 (−1 idle), `carry` Troopers ordered to it and not yet inside (owner-only in views).
   * A new hole does not take a housed Trooper, so whoever steps out onto a doorstep that caved in meanwhile settles
   * on the hole then (settleOnHole).
   */
  updateConversions(this: Sim): void {
    for (const e of this.ents) {
      if (e.dead || !e.hangar || e.plane !== 'surface') continue;
      const yard = this.alive(e.hangar);
      if (yard && yard.kind === 'drill_yard' && yard.side === e.side && yard.hp > 0) continue;
      e.hangar = 0;
      e.state = 'idle';
      this.order(e, NONE);
      const c = cellOfEnt(e, this.size);
      if (this.holes[c]) this.settleOnHole(e, c);
    }
    const s = this.stats.breacher;
    for (const y of this.ents) {
      if (y.dead || y.kind !== 'drill_yard' || !y.built || y.hp <= 0 || !isArmy(y.side)) continue;
      const army = y.side;
      let inside = y.link ? this.alive(y.link) : undefined;
      if (inside && inside.hangar !== y.id) inside = undefined;
      let waiting = 0;
      let next: Ent | undefined;
      for (const u of this.ents) {
        if (u.dead || u.side !== army || u.hangar || u.plane !== 'surface' || u.order.k !== 'convert' || u.order.yard !== y.id) continue;
        waiting++;
        if (u.order.at && (!next || u.seq < next.seq)) next = u;
      }
      y.carry = waiting;
      if (!inside && next && this.econ.breachersEnabled && this.spend(army, s.alloy, s.energy, 'surface')) {
        next.hangar = y.id;
        next.state = 'converting';
        next.vx = next.vy = next.avx = next.avy = 0;
        next.engage = next.aimTarget = next.faceTarget = 0;
        next.firing = false;
        inside = next;
        y.workT = 0;
        y.carry = waiting - 1;
      }
      if (!inside) {
        y.link = 0;
        y.workT = 0;
        y.progress = -1;
        y.state = 'idle';
        continue;
      }
      y.link = inside.id;
      y.state = 'active';
      y.workT++;
      y.progress = Math.min(1, y.workT / Math.max(1, s.build));
      if (y.workT >= s.build) this.finishConversion(y, inside);
    }
  }

  /**
   * Trooper `e` leaves yard `y` a Breacher: a new unit where it stood (the Trooper is removed without a loss), keeping
   * its HP fraction, stance, seat and queued orders after the `convert`; its replacement value adds the conversion.
   */
  finishConversion(this: Sim, y: Ent, e: Ent): void {
    const army = y.side;
    const s = this.stats.breacher;
    const b = this.add('breacher', army, 'surface', e.x, e.y);
    b.hp = b.maxHp * (e.hp / e.maxHp);
    b.stance = e.stance;
    b.heading = e.heading;
    b.aim = e.aim;
    b.productionRole = e.productionRole;
    b.replacementAlloy = e.replacementAlloy + s.alloy;
    b.replacementEnergy = e.replacementEnergy + s.energy;
    b.queue = e.queue;
    e.queue = [];
    this.clearOrder(b);
    // Gone without a loss: no death, no pop change (the Breacher takes the Trooper's place); cleanup drops it.
    e.dead = true;
    e.hp = 0;
    e.hangar = 0;
    y.link = 0;
    y.workT = 0;
    y.progress = -1;
    y.state = 'idle';
    this.armies[army]!.stats.conversions++;
    this.emit([army], 'produced', 'surface', b.x, b.y, 'breacher', army, b.productionRole ? { owner: b.productionRole } : undefined);
    const c = cellOfEnt(b, this.size);
    if (this.holes[c]) this.settleOnHole(b, c);
  }
}
