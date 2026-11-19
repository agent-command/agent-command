/** Research and effective stats: upgrade eligibility, compiled per-army modifier rows, abilities and reveal of hostile effects. */
import {
  ABILITY_RULES,
  type AbilityId,
  type Capabilities,
  isNeutralKind,
  isStatKind,
  isStructureKind,
  isUpgrade,
  type Plane,
  PLANES,
  type QueueItem,
  STAT_KEYS,
  type StatKey,
  type StatKind,
  type Stats,
  type Upgrade,
  UPGRADE_IDS,
  type UpgradeCost,
  type UpgradeId,
  type UpgradeReveal,
  UPGRADES,
  type UpgradeSelector,
} from '../rules/contract.ts';
import { type Army, isArmy } from '../util/teams.ts';
import { ACCOUNT_REFUND } from './constants.ts';
import { type EffectiveStats, Ent, NEUTRAL_STATS } from './ent.ts';
import type { Sim } from './sim.ts';
import type { ModifierRows } from './state.ts';

/** Capabilities some upgrade grants: only these consult the army's research; the rest are the static registry flag. */
const GRANTED: Partial<Record<keyof Capabilities, true>> = {};
for (const upgrade of Object.values(UPGRADES)) for (const effect of upgrade.effects) if (effect.kind === 'grant_capability') GRANTED[effect.capability] = true;

export class SimResearch {
  capable(this: Sim, e: Ent, capability: keyof Capabilities): boolean {
    if (e.capabilities[capability]) return true;
    if (!GRANTED[capability] || !isArmy(e.side) || !isStatKind(e.kind)) return false;
    for (const id of this.armies[e.side]!.research) {
      const upgrade = UPGRADES[id];
      if (!this.upgradeApplies(e, upgrade)) continue;
      for (const effect of upgrade.effects) if (effect.kind === 'grant_capability' && effect.capability === capability && effect.units.includes(e.kind)) return true;
    }
    return false;
  }

  upgradeApplies(this: Sim, e: Ent, upgrade: Upgrade): boolean {
    return upgrade.scope === 'team' || e.plane === upgrade.at;
  }

  selected(this: Sim, e: Ent, selector: UpgradeSelector): boolean {
    if ('kinds' in selector) return isStatKind(e.kind) && selector.kinds.includes(e.kind);
    if ('structures' in selector) return e.structure;
    return e.kind === 'spire' && e.plane === selector.segment;
  }

  /** The registry row of `e`'s kind; undefined for islands and asteroids (they have none). */
  statsOf(this: Sim, e: Ent): Stats | undefined {
    return isStatKind(e.kind) ? this.stats[e.kind] : undefined;
  }

  /** The sole runtime lookup for modifiable stats. Passive effects are compiled once, not once per unit decision. */
  stat(this: Sim, e: Ent): EffectiveStats {
    if (this.modifierRows && e.statPlane !== e.plane) {
      e.statPlane = e.plane;
      const rows = isArmy(e.side) ? this.modifierRows[e.side] : undefined;
      e.statRow = isStatKind(e.kind) ? rows?.[e.plane][e.kind] ?? this.baseStatRows[e.plane][e.kind] : NEUTRAL_STATS;
    }
    return e.statRow;
  }

  /** Compile-time evaluation in stable registry order; called only when an army's passive upgrades change. */
  modifiedStat(this: Sim, e: Ent, key: StatKey): number {
    const row = isNeutralKind(e.kind) ? undefined : this.stats[e.kind];
    let value = key === 'damage_taken' ? 1 : key === 'hp' && e.kind === 'spire' ? this.spireHp[e.plane] : row ? row[key] : key === 'hp' ? e.maxHp : 0;
    if (isArmy(e.side)) {
      for (const id of UPGRADE_IDS) {
        if (!this.armies[e.side]!.research.has(id)) continue;
        const upgrade = UPGRADES[id];
        if (!this.upgradeApplies(e, upgrade)) continue;
        for (const effect of upgrade.effects) {
          if (effect.kind === 'modifier' && effect.stat === key && this.selected(e, effect.target)) value = (value + (effect.add ?? 0)) * (effect.multiply ?? 1);
        }
      }
    }
    return key === 'damage_taken' && e.kind === 'spire' ? Math.max(1 - this.econ.shieldCap, value) : Math.max(0, value);
  }

  compileModifiers(this: Sim, army: Army): void {
    const rows = {} as ModifierRows;
    const sample = new Ent();
    this.setSide(sample, army);
    const kinds = Object.keys(this.stats) as StatKind[];
    for (const plane of PLANES) {
      sample.plane = plane;
      const byKind = {} as ModifierRows[Plane];
      rows[plane] = byKind;
      for (const kind of kinds) {
        sample.kind = kind;
        sample.structure = isStructureKind(kind);
        const values = {} as Record<StatKey, number>;
        byKind[kind] = values;
        for (const key of STAT_KEYS) values[key] = this.modifiedStat(sample, key);
      }
    }
    (this.modifierRows ??= [])[army] = rows;
    for (const e of this.ents) {
      if (e.side !== army || e.dead || isNeutralKind(e.kind)) continue;
      e.statPlane = e.plane;
      e.statRow = rows[e.plane][e.kind];
    }
  }

  hasAbility(this: Sim, e: Ent, ability: AbilityId): boolean {
    if (isNeutralKind(e.kind)) return false;
    const spec = ABILITY_RULES[ability];
    if (spec.plane && spec.plane !== e.plane) return false;
    if (this.stats[e.kind].abilities.includes(ability)) return true;
    if (!isArmy(e.side)) return false;
    for (const id of this.armies[e.side]!.research) {
      const upgrade = UPGRADES[id];
      if (!this.upgradeApplies(e, upgrade)) continue;
      for (const effect of upgrade.effects) if (effect.kind === 'grant_ability' && effect.ability === ability && effect.units.includes(e.kind)) return true;
    }
    return false;
  }

  /** Unlock effects gate their kinds; kinds with no unlock entry are base buildables. Rule-disabled kinds never are. */
  canBuild(this: Sim, army: Army, kind: Exclude<QueueItem, UpgradeId | 'rebuild'>): boolean {
    if ((kind === 'gunship' && !this.econ.gunshipEnabled) || (kind === 'storm_seeder' && !this.econ.seederEnabled) || (kind === 'drill_yard' && !this.econ.breachersEnabled)) return false;
    if (kind === 'mooring_tower' && !this.econ.mooringEnabled) return false;
    let locked = false;
    for (const id of UPGRADE_IDS) {
      const upgrade = UPGRADES[id];
      for (const effect of upgrade.effects) {
        if (effect.kind !== 'unlock' || !effect.items.includes(kind)) continue;
        locked = true;
        if (this.armies[army]!.research.has(id) && (upgrade.scope === 'team' || this.stats[kind].plane === upgrade.at)) return true;
      }
    }
    return !locked;
  }

  researchEligible(this: Sim, army: Army, id: UpgradeId): boolean {
    const t = this.armies[army]!;
    const upgrade = UPGRADES[id];
    return (!upgrade.enabled || this.econ[upgrade.enabled]) && this.segmentAlive(army, upgrade.at) && !t.research.has(id) && !t.queue.some((entry) => entry.item === id)
      && upgrade.requires.upgrades.every((required) => t.research.has(required));
  }

  researchAvailable(this: Sim, army: Army): UpgradeId[] {
    return UPGRADE_IDS.filter((id) => this.researchEligible(army, id));
  }

  queueStats(this: Sim, item: QueueItem, producer = 0): UpgradeCost {
    if (item === 'rebuild') return this.rebuildStats;
    return producer && item === 'digger' ? this.shaftDiggerStats : isUpgrade(item) ? this.upgrades[item] : this.stats[item];
  }

  /** A reveal is earned by witnessing the effect, never by merely seeing its researched unit. */
  revealAbility(this: Sim, e: Ent, ability: AbilityId): void {
    if (!this.hasAbility(e, ability)) return;
    this.revealEffect(e, 'ability', ability);
  }

  /**
   * Every vision group hostile to `e`'s army that sees `e` now learns the not-yet-seen upgrades of that army whose
   * reveal this effect matches (`seenResearch[army]` of the observing group).
   */
  revealEffect(this: Sim, e: Ent, kind: UpgradeReveal['kind'], value: string): void {
    if (!isArmy(e.side)) return;
    const researched = this.armies[e.side]!.research;
    if (researched.size === 0) return;
    for (const g of this.groups) {
      const viewer = g.armies[0]!;
      if (!this.hostile(viewer, e.side)) continue;
      const known = g.seenResearch[e.side]!;
      if (known.size === researched.size) continue;
      let visible: boolean | undefined;
      for (const id of researched) {
        if (known.has(id)) continue;
        const upgrade = UPGRADES[id];
        const reveal = upgrade.reveal;
        if (reveal.kind !== kind || !this.upgradeApplies(e, upgrade)) continue;
        let matches = reveal.kind === 'unit' && reveal.unit === value;
        if (reveal.kind === 'ability' && reveal.ability === value) {
          for (const effect of upgrade.effects) if (effect.kind === 'grant_ability' && effect.ability === value && isStatKind(e.kind) && effect.units.includes(e.kind)) { matches = true; break; }
        } else if (reveal.kind === 'capability' && reveal.capability === value) {
          for (const effect of upgrade.effects) if (effect.kind === 'grant_capability' && effect.capability === value && isStatKind(e.kind) && effect.units.includes(e.kind)) { matches = true; break; }
        } else if (reveal.kind === 'modifier' && reveal.stat === value) {
          for (const effect of upgrade.effects) if (effect.kind === 'modifier' && effect.stat === value && this.selected(e, effect.target)) { matches = true; break; }
        }
        if (!matches) continue;
        visible ??= this.sees(viewer, e);
        if (!visible) break;
        known.add(id);
      }
    }
  }

  completeResearch(this: Sim, army: Army, id: UpgradeId): void {
    const t = this.armies[army]!;
    t.research.add(id);
    if (UPGRADES[id].effects.some((effect) => effect.kind === 'modifier')) this.compileModifiers(army);
    // HP is stored on entities; preserve damage already taken when maximum HP changes.
    for (const e of this.ents) {
      if (e.dead || e.side !== army || isNeutralKind(e.kind)) continue;
      const hp = this.stat(e).hp;
      if (hp !== e.maxHp && UPGRADES[id].effects.some((effect) => effect.kind === 'modifier' && effect.stat === 'hp' && this.upgradeApplies(e, UPGRADES[id]) && this.selected(e, effect.target))) {
        e.hp = Math.max(0, e.hp + hp - e.maxHp);
        e.maxHp = hp;
      }
    }
  }

  cancelSegmentResearch(this: Sim, army: Army, plane: Plane): void {
    const t = this.armies[army]!;
    for (let i = t.queue.length - 1; i >= 0; i--) {
      const entry = t.queue[i]!;
      if (entry.plane !== plane || !isUpgrade(entry.item)) continue;
      if (entry.started) {
        const cost = this.upgrades[entry.item];
        t.alloy += cost.alloy * this.econ.segmentLossRefund;
        t.energy += cost.energy * this.econ.segmentLossRefund;
        this.account(army, ACCOUNT_REFUND, cost.alloy * this.econ.segmentLossRefund, cost.energy * this.econ.segmentLossRefund, entry.by);
      }
      t.queue.splice(i, 1);
      this.queueEvent(army, 'queue_cancelled', entry, plane, i, undefined, 'segment_destroyed');
    }
  }
}
