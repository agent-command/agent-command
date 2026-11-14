/**
 * Research upgrades and abilities: the upgrade registry, its effects and match-resolved costs, and the rule keys
 * behind each ability's cost and cooldown.
 */
import type { EconNumber } from './econ.ts';
import type { Rules } from './match-rules.ts';
import { type EconToggle, ruleToggle } from './rule-tables.ts';
import type { Capabilities, StatKind } from './stats.ts';
import { type AbilityId, type Plane, type QueueItem, type StructureKind, toTicks, type UnitKind, type UpgradeId } from './vocabulary.ts';

export const isUpgrade = (item: string): item is UpgradeId => Object.hasOwn(UPGRADES, item);
/** Ability costs/cooldowns use the same compiled match-rule keys for base and researched verbs; passives have no cooldown. */
export const ABILITY_RULES: Record<AbilityId, { energy?: EconNumber; cooldown?: EconNumber; plane?: Plane }> = {
  scan: { energy: 'scanCost', cooldown: 'scanCooldownTicks', plane: 'orbit' },
  ascend: { energy: 'ascentEnergy', cooldown: 'ascentCooldown' },
  sun_lance: { energy: 'lanceEnergy', cooldown: 'lanceCooldown', plane: 'orbit' },
  aegis: { energy: 'aegisEnergy', cooldown: 'aegisCooldown', plane: 'orbit' },
  night_cloak: { cooldown: 'cloakBreakTime', plane: 'orbit' },
  flare: { cooldown: 'flareCooldown', plane: 'depths' },
  drill_bits: { plane: 'depths' },
  shaped_charges: { plane: 'depths' },
};

/** Stats an upgrade modifier may change. */
export const STAT_KEYS = ['hp', 'speed', 'dmg', 'range', 'cooldown', 'vision', 'damage_taken'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type UpgradeSelector = { kinds: readonly (UnitKind | StructureKind)[] } | { structures: true } | { segment: Plane };
export type UpgradeEffect =
  | { kind: 'unlock'; items: readonly Exclude<QueueItem, UpgradeId>[] }
  | { kind: 'grant_ability'; units: readonly (UnitKind | StructureKind)[]; ability: AbilityId }
  | { kind: 'grant_capability'; units: readonly (UnitKind | StructureKind)[]; capability: keyof Capabilities }
  | { kind: 'modifier'; target: UpgradeSelector; stat: StatKey; add?: number; multiply?: number };
export type UpgradeReveal = { kind: 'ability'; ability: AbilityId } | { kind: 'capability'; capability: keyof Capabilities }
  | { kind: 'unit'; unit: Exclude<QueueItem, UpgradeId> } | { kind: 'modifier'; stat: StatKey };
export interface Upgrade {
  id: UpgradeId;
  label: string;
  docs: string;
  at: Plane;
  cost: { alloy: number; energy: number };
  /** Research duration in seconds. */
  time: number;
  /** Optional match-rule overrides, resolved generically by resolveUpgrade. */
  rules?: {
    alloy: 'ascentThrustersAlloy' | 'aegisProjectorsAlloy' | 'nightCloakAlloy' | 'lancerLensAlloy' | 'drillBitsAlloy' | 'shapedChargesAlloy';
    energy: 'ascentThrustersEnergy' | 'aegisProjectorsEnergy' | 'nightCloakEnergy' | 'lancerLensEnergy' | 'drillBitsEnergy' | 'shapedChargesEnergy';
    time: 'ascentThrustersTime' | 'aegisProjectorsTime' | 'nightCloakTime' | 'lancerLensTime' | 'drillBitsTime' | 'shapedChargesTime';
  };
  /** On/off match rule (an Econ boolean, `<group>.<feature>Enabled`); off: no army may research it. */
  enabled?: EconToggle;
  requires: { upgrades: readonly UpgradeId[] };
  scope: 'team' | 'segment';
  reveal: UpgradeReveal;
  effects: readonly UpgradeEffect[];
}
export const UPGRADES: Record<UpgradeId, Upgrade> = {
  ascent_thrusters: {
    id: 'ascent_thrusters', label: 'Ascent Thrusters', docs: 'Interceptors can temporarily climb into Orbit to raid orbital units and the Orbit Spire.',
    at: 'sky', cost: { alloy: 150, energy: 100 }, time: 30,
    rules: { alloy: 'ascentThrustersAlloy', energy: 'ascentThrustersEnergy', time: 'ascentThrustersTime' },
    requires: { upgrades: [] }, scope: 'team', reveal: { kind: 'ability', ability: 'ascend' },
    effects: [{ kind: 'grant_ability', units: ['interceptor'], ability: 'ascend' }],
  },
  aegis_projectors: {
    id: 'aegis_projectors', label: 'Aegis Projectors', docs: 'Bastions can root themselves and project a shared shield pool over nearby allied Orbit ships.',
    at: 'orbit', cost: { alloy: 100, energy: 100 }, time: 25,
    rules: { alloy: 'aegisProjectorsAlloy', energy: 'aegisProjectorsEnergy', time: 'aegisProjectorsTime' },
    requires: { upgrades: [] }, scope: 'team', reveal: { kind: 'ability', ability: 'aegis' },
    effects: [{ kind: 'grant_ability', units: ['bastion'], ability: 'aegis' }],
  },
  night_cloak: {
    id: 'night_cloak', label: 'Night Cloak', docs: 'Skiffs automatically cloak in darkness while not firing. Damage, firing or daylight breaks cloak; close ships, scans, the Orbit segment and Bastion radar detect it.',
    at: 'orbit', cost: { alloy: 125, energy: 100 }, time: 30,
    rules: { alloy: 'nightCloakAlloy', energy: 'nightCloakEnergy', time: 'nightCloakTime' },
    requires: { upgrades: [] }, scope: 'team', reveal: { kind: 'ability', ability: 'night_cloak' },
    effects: [{ kind: 'grant_ability', units: ['skiff'], ability: 'night_cloak' }],
  },
  lancer_lens: {
    id: 'lancer_lens', label: 'Lancer Lens', docs: 'Lancers also beam Sky units directly below them, within a short horizontal reach, at reduced damage.',
    at: 'orbit', cost: { alloy: 100, energy: 100 }, time: 25,
    rules: { alloy: 'lancerLensAlloy', energy: 'lancerLensEnergy', time: 'lancerLensTime' }, enabled: 'lancerLensEnabled',
    requires: { upgrades: [] }, scope: 'team', reveal: { kind: 'capability', capability: 'lens' },
    effects: [{ kind: 'grant_capability', units: ['lancer'], capability: 'lens' }],
  },
  drill_bits: {
    id: 'drill_bits', label: 'Drill Bits', docs: 'Diggers dig cells open (rock, ore, fortified rock) in three quarters of the time. Mining loads and breaking bulkheads are unchanged.',
    at: 'depths', cost: { alloy: 100, energy: 60 }, time: 25,
    rules: { alloy: 'drillBitsAlloy', energy: 'drillBitsEnergy', time: 'drillBitsTime' }, enabled: 'drillBitsEnabled',
    requires: { upgrades: [] }, scope: 'team', reveal: { kind: 'ability', ability: 'drill_bits' },
    effects: [{ kind: 'grant_ability', units: ['digger'], ability: 'drill_bits' }],
  },
  shaped_charges: {
    id: 'shaped_charges', label: 'Shaped Charges', docs: 'Sapper charges blow sooner (shorter fuse) and split a fault farther each way into a longer chasm.',
    at: 'depths', cost: { alloy: 120, energy: 80 }, time: 30,
    rules: { alloy: 'shapedChargesAlloy', energy: 'shapedChargesEnergy', time: 'shapedChargesTime' }, enabled: 'shapedChargesEnabled',
    requires: { upgrades: [] }, scope: 'team', reveal: { kind: 'ability', ability: 'shaped_charges' },
    effects: [{ kind: 'grant_ability', units: ['sapper'], ability: 'shaped_charges' }],
  },
};

/** Existing unit kinds a research effect benefits; shared by bootstrap, strategy and match probes. */
export function upgradeBeneficiaries(id: UpgradeId): StatKind[] {
  const units: StatKind[] = [];
  for (const effect of UPGRADES[id].effects) {
    const kinds = effect.kind === 'grant_ability' || effect.kind === 'grant_capability' ? effect.units
      : effect.kind === 'modifier' && 'kinds' in effect.target ? effect.target.kinds : [];
    for (const kind of kinds) if (!units.includes(kind)) units.push(kind);
  }
  return units;
}

export interface UpgradeCost {
  alloy: number;
  energy: number;
  build: number;
  plane: Plane;
}

/** Is research `id` offered in this match (its `enabled` rule, when it has one, is on)? The sim reads the same key from Econ. */
export function upgradeEnabled(rules: Rules, id: UpgradeId): boolean {
  const key = UPGRADES[id].enabled;
  return key === undefined || ruleToggle(rules, key);
}

/** Resolve a registry upgrade's match costs and duration (ticks), without special-casing its identity. */
export function resolveUpgrade(rules: Rules, id: UpgradeId): UpgradeCost {
  const upgrade = UPGRADES[id];
  const keys = upgrade.rules;
  return {
    alloy: keys ? rules.research[keys.alloy] : upgrade.cost.alloy,
    energy: keys ? rules.research[keys.energy] : upgrade.cost.energy,
    build: toTicks(keys ? rules.research[keys.time] : upgrade.time),
    plane: upgrade.at,
  };
}
