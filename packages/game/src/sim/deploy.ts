/**
 * Deploy stances (rules/deploy.ts): one mechanism for the Warden shield wall, the dug-in Trooper, the sieged tank and
 * emplaced flak. Phases live on `Ent.deploy`/`deployAt`; every number comes from the stance's ECON keys.
 */
import { DEPLOY_SPECS, type DeploySpec } from '../rules/contract.ts';
import { cellOfEnt } from '../util/grid.ts';
import { sq } from '../util/math.ts';
import { isArmy, type SideId } from '../util/teams.ts';
import { DEPLOY_DEPLOYING, DEPLOY_NONE, DEPLOY_PACKING, DEPLOY_UP, SEP_DEADBAND, SNAP_EPS } from './constants.ts';
import { type Ent, NONE } from './ent.ts';
import type { Sim } from './sim.ts';

export class SimDeploy {
  /** `e`'s deploy stance spec, if its kind has one. */
  deploySpec(this: Sim, e: Ent): DeploySpec | undefined {
    const stance = this.statsOf(e)?.deploy;
    return stance === undefined ? undefined : DEPLOY_SPECS[stance];
  }

  /** Fully deployed `e`'s spec (undefined while mobile or in a transition). */
  deployedSpec(this: Sim, e: Ent): DeploySpec | undefined {
    return e.deploy === DEPLOY_UP ? this.deploySpec(e) : undefined;
  }

  /** Do not root overlapping friendly shield bearers before ordinary separation can settle them. */
  deployClear(this: Sim, e: Ent): boolean {
    if (!this.deploySpec(e)?.blocksCell) return true;
    for (const other of this.ents) {
      if (other === e || other.dead || other.plane !== e.plane || this.hostile(e.side, other.side) || !this.deploySpec(other)?.blocksCell) continue;
      const reach = e.radius + other.radius - SEP_DEADBAND;
      if (sq(e.x - other.x) + sq(e.y - other.y) < reach * reach - SNAP_EPS) return false;
    }
    return true;
  }

  /** `e` starts deploying where it stands: orders and queue go (the stance is the order) and it stops dead. */
  startDeploy(this: Sim, e: Ent): void {
    const spec = this.deploySpec(e)!;
    this.order(e, NONE);
    e.vx = e.vy = e.avx = e.avy = 0;
    const ticks = this.econ[spec.deployTicks];
    e.deploy = ticks > 0 ? DEPLOY_DEPLOYING : DEPLOY_UP;
    e.deployAt = this.tick + ticks;
    e.state = spec.states[e.deploy === DEPLOY_UP ? 1 : 0];
    e.progress = e.deploy === DEPLOY_UP ? -1 : 0;
    e.firing = false;
    this.armies[e.side]!.stats.deploys++;
  }

  /** `e` starts packing up (a deploy in progress turns round at once). */
  pack(this: Sim, e: Ent): void {
    if (e.deploy !== DEPLOY_DEPLOYING && e.deploy !== DEPLOY_UP) return;
    const spec = this.deploySpec(e)!;
    const ticks = this.econ[spec.packTicks];
    e.deploy = ticks > 0 ? DEPLOY_PACKING : DEPLOY_NONE;
    e.deployAt = this.tick + ticks;
    e.state = e.deploy === DEPLOY_NONE ? 'idle' : spec.states[2];
    e.progress = e.deploy === DEPLOY_NONE ? -1 : 0;
    e.firing = false;
  }

  /** Drop any stance at once (the unit left its plane, e.g. fell into the Depths). */
  clearDeploy(this: Sim, e: Ent): void {
    if (e.deploy === DEPLOY_NONE) return;
    e.deploy = DEPLOY_NONE;
    e.deployAt = 0;
    e.firing = false;
    e.progress = -1;
    e.state = 'idle';
  }

  /**
   * A deploying, deployed or packing unit's decision: it never moves. Any order but `attack` (focus fire from where it
   * stands) packs it first; the order runs once it is mobile. Transitions finish here, in the decision phase: cells
   * others steer by and covers were stamped from the start-of-tick phases (stampDeploys).
   */
  updateDeploy(this: Sim, e: Ent): void {
    const spec = this.deploySpec(e)!;
    const o = e.order;
    if (o.k === 'attack') {
      const t = this.alive(o.target);
      if (!t || !this.sees(e.side, t) || !this.isTarget(e, t) || !this.canHit(e, t.plane)) this.clearOrder(e);
    }
    if (e.order.k !== 'none' && e.order.k !== 'attack') this.pack(e);
    if (this.tick >= e.deployAt) {
      if (e.deploy === DEPLOY_DEPLOYING) e.deploy = DEPLOY_UP;
      else if (e.deploy === DEPLOY_PACKING) e.deploy = DEPLOY_NONE;
    }
    e.engage = 0;
    e.firing = e.deploy === DEPLOY_UP && spec.fires;
    if (e.deploy === DEPLOY_NONE) {
      e.state = 'idle';
      e.progress = -1;
      return;
    }
    const span = this.econ[e.deploy === DEPLOY_DEPLOYING ? spec.deployTicks : spec.packTicks];
    e.state = spec.states[e.deploy === DEPLOY_DEPLOYING ? 0 : e.deploy === DEPLOY_UP ? 1 : 2];
    e.progress = e.deploy === DEPLOY_UP ? -1 : Math.min(1, Math.max(0, 1 - (e.deployAt - this.tick) / span));
  }

  /**
   * Before anyone decides: hostile-army masks for blocking stances (including transitions), plus fully deployed
   * cover auras. The upper byte accumulates this tick's masks; the lower byte holds last tick's mask until the sweep.
   * Comparing masks catches overlapping walls and ownership changes as well as deployment/death, invalidating
   * smoothed waypoints without allocating or sweeping an empty map.
   */
  stampDeploys(this: Sim): void {
    const covers = this.covers;
    covers.length = 0;
    const cells = this.wallCells;
    let count = 0;
    let changed = false;
    for (const e of this.ents) {
      if (e.dead || e.deploy === DEPLOY_NONE) continue;
      const spec = this.deploySpec(e);
      if (!spec) continue;
      if (e.deploy === DEPLOY_UP && spec.cover) covers.push(e);
      if (!spec.blocksCell || e.plane !== 'depths') continue;
      const c = cellOfEnt(e, this.size);
      cells[c]! |= this.hostileMask[e.side]! << 8;
      count++;
    }
    if (count === 0 && this.wallCount === 0) return;
    for (let c = 0; c < this.n; c++) {
      const previous = cells[c]! & 0xff, current = cells[c]! >>> 8;
      if (previous !== current) changed = true;
      cells[c] = current;
    }
    this.wallCount = count;
    if (changed) this.depthsVersion++;
  }

  /**
   * Whole-damage multiplier from stances for unit `e`: a fully deployed stance whose reduction covers all damage
   * (no weapon filter: the shield wall); otherwise a hostile hit on a unit in an own cover aura. Weapon-filtered
   * reductions (dug in) apply per hit in `weaponVs`.
   */
  deployFactor(this: Sim, e: Ent, by: SideId): number {
    if (!e.unit) return 1;
    const spec = this.deployedSpec(e);
    if (spec?.damageTaken && !spec.damageFrom) return this.econ[spec.damageTaken];
    if (!isArmy(by) || !this.hostile(by, e.side)) return 1;
    const cover = this.coverOf(e);
    return cover ? this.econ[cover.damageTaken] : 1;
  }

  /** The cover aura `e` stands in: another fully deployed own unit's on its plane within the aura's reach. */
  coverOf(this: Sim, e: Ent): DeploySpec['cover'] {
    if (this.covers.length === 0 || !e.unit) return undefined;
    for (const w of this.covers) {
      if (w === e || w.side !== e.side || w.dead || w.plane !== e.plane || w.deploy !== DEPLOY_UP) continue;
      const cover = this.deploySpec(w)!.cover!;
      const r = this.econ[cover.reach];
      if (sq(w.x - e.x) + sq(w.y - e.y) <= r * r + SNAP_EPS) return cover;
    }
    return undefined;
  }

  /** Extra weapon range from bracing in an own cover aura (0 outside cover). */
  coverRange(this: Sim, e: Ent): number {
    const cover = this.coverOf(e);
    return cover ? this.econ[cover.range] : 0;
  }

  /** Extra vision (tiles) of a fully deployed stance. */
  deployVision(this: Sim, e: Ent): number {
    const vision = this.deployedSpec(e)?.vision;
    return vision ? this.econ[vision] : 0;
  }

  /** Ticks between shots: stats cooldown, × the deployed stance's multiplier (whole ticks, at least 1). */
  cooldownOf(this: Sim, e: Ent): number {
    const base = this.stat(e).cooldown;
    const mult = this.deployedSpec(e)?.cooldown;
    return mult ? Math.max(1, Math.round(base * this.econ[mult])) : base;
  }
}
