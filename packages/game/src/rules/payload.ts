/**
 * Falling payloads (asteroids today): economy keys for each size, resource type and independent volatility, compiled once
 * per match into plain numeric rows for the drop pipeline.
 */
import type { Econ, EconNumber } from './econ.ts';
import type { Kind, Plane, RockResourceType, RockSize } from './vocabulary.ts';

/** Numeric constants or keys in the match's compiled economy table (durations are ticks). */
type PayloadValue = number | EconNumber;

export interface PayloadDrop {
  readonly from: Plane;
  /** Public launch-to-impact countdown; overlaps, rather than precedes, the fall. */
  readonly warning: PayloadValue;
  /** Travel duration ending at impact. */
  readonly fall: PayloadValue;
  readonly hp: PayloadValue;
  readonly interceptable: boolean;
  readonly impact: {
    readonly damage: PayloadValue;
    readonly radius: PayloadValue;
    /** Radius of crater cells, measured from their centres; zero leaves no crater. */
    readonly crater: PayloadValue;
  };
  /** Damage cause recorded for the impact (metrics tell asteroid impacts from core drops apart). */
  readonly cause: 'impact' | 'core_drop';
  /** Extra impact damage × (1 − heat / 100) of the payload (the derelict core: a cool core hits harder). */
  readonly cool?: PayloadValue;
  /** Ground left burning in the impact radius: duration (ticks) and damage per second to Surface units. */
  readonly scorch?: { readonly ticks: PayloadValue; readonly dps: PayloadValue };
}

/** All rock sizes, resources and volatility use the same interception and impact pipeline. */
export const PAYLOADS = {
  asteroid: {
    drop: {
      from: 'orbit',
      warning: 'impactTicks',
      fall: 'impactTicks',
      hp: 'asteroidHp',
      interceptable: true,
      impact: { damage: 'impactDamage', radius: 'impactRadius', crater: 'impactCraterRadius' },
      cause: 'impact',
    },
    sizes: {
      pebble: { hp: 'pebbleHp', tow: 'pebbleTowSpeed', dock: 'pebbleDockValue', warning: 'pebbleImpactTicks', damage: 'pebbleImpactDamage', radius: 'pebbleImpactRadius', crater: 'pebbleCraterRadius' },
      medium: { hp: 'asteroidHp', tow: 'towSpeed', dock: 'dockValue', warning: 'impactTicks', damage: 'impactDamage', radius: 'impactRadius', crater: 'impactCraterRadius' },
      large: { hp: 'largeHp', tow: 'largeTowSpeed', dock: 'largeDockValue', warning: 'largeImpactTicks', damage: 'largeImpactDamage', radius: 'largeImpactRadius', crater: 'largeCraterRadius' },
    },
    resources: {
      metal: { cache: 'oreCacheMultiplier' },
      ice: {},
      slag: {},
    },
    volatile: {
      damage: 'volatileDamageMultiplier', radius: 'volatileRadiusMultiplier', scorch: 'scorchTicks',
      tow: { fuse: 'volatileFuseTicks', hpFraction: 'volatileTowHpFraction', damage: 'volatileOrbitDamage', radius: 'volatileOrbitRadius' },
    },
  },
  /** The derelict core (DESIGN §4.4): a tug drops it like a rock; the cooler it is, the harder it hits. */
  core: {
    drop: {
      from: 'orbit',
      warning: 'coreDropTicks',
      fall: 'coreDropTicks',
      hp: 'coreHp',
      interceptable: true,
      impact: { damage: 'coreDropDamage', radius: 'coreDropRadius', crater: 'coreDropCrater' },
      cause: 'core_drop',
      cool: 'coreDropCoolBonus',
      scorch: { ticks: 'coreIrradiateTicks', dps: 'coreIrradiateDps' },
    },
  },
} as const satisfies Partial<Record<Kind, { readonly drop: PayloadDrop; readonly sizes?: unknown; readonly resources?: unknown; readonly volatile?: unknown }>>;

export type PayloadKind = keyof typeof PAYLOADS;
export interface ResolvedPayloadDrop {
  readonly from: Plane;
  readonly warning: number;
  readonly fall: number;
  readonly hp: number;
  readonly interceptable: boolean;
  readonly impact: { readonly damage: number; readonly radius: number; readonly crater: number };
  readonly cause: 'impact' | 'core_drop';
  readonly cool?: number;
  readonly oreValue?: number;
  /** ticks the impact radius burns, at scorchDps per second */
  readonly scorch?: number;
  readonly scorchDps?: number;
}
export type ResolvedPayloads = Readonly<Partial<Record<Kind, ResolvedPayloadDrop>>>;

/** Resolve once per match; the drop pipeline shares these rows without per-tick allocations. */
export function resolvePayloads(econ: Econ): ResolvedPayloads {
  const value = (v: PayloadValue): number => (typeof v === 'number' ? v : econ[v]);
  const rows: Partial<Record<Kind, ResolvedPayloadDrop>> = {};
  for (const kind of Object.keys(PAYLOADS) as PayloadKind[]) {
    const drop: PayloadDrop = PAYLOADS[kind].drop;
    rows[kind] = {
      from: drop.from,
      warning: value(drop.warning),
      fall: value(drop.fall),
      hp: value(drop.hp),
      interceptable: drop.interceptable,
      impact: { damage: value(drop.impact.damage), radius: value(drop.impact.radius), crater: value(drop.impact.crater) },
      cause: drop.cause,
      ...(drop.cool === undefined ? {} : { cool: value(drop.cool) }),
      ...(drop.scorch ? { scorch: value(drop.scorch.ticks), scorchDps: value(drop.scorch.dps) } : {}),
    };
  }
  return rows;
}

export interface ResolvedRock {
  readonly hp: number;
  readonly tow: number;
  /** Size base value before resource conversion. */
  readonly dock: number;
  readonly dockYield: Readonly<Record<RockResourceType, { readonly alloy: number; readonly energy: number }>>;
  /** Hull removed per actual cargo unit; zero for resources with no economic yield. */
  readonly mineHpPerUnit: Readonly<Record<RockResourceType, number>>;
  readonly drops: Readonly<Record<RockResourceType, ResolvedPayloadDrop>>;
  readonly volatileDrops: Readonly<Record<RockResourceType, ResolvedPayloadDrop>>;
  readonly volatileTow: { readonly fuse: number; readonly hp: number; readonly damage: number; readonly radius: number };
}

/** Compiled once per match: choosing size, resource and volatility is a lookup, never a tick allocation. */
export function resolveRocks(econ: Econ): Readonly<Record<RockSize, ResolvedRock>> {
  const rows = {} as Record<RockSize, ResolvedRock>;
  for (const size of Object.keys(PAYLOADS.asteroid.sizes) as RockSize[]) {
    const spec = PAYLOADS.asteroid.sizes[size];
    const base: ResolvedPayloadDrop = {
      from: PAYLOADS.asteroid.drop.from,
      warning: econ[spec.warning],
      fall: econ[spec.warning],
      hp: econ[spec.hp],
      interceptable: PAYLOADS.asteroid.drop.interceptable,
      impact: { damage: econ[spec.damage], radius: econ[spec.radius], crater: econ[spec.crater] },
      cause: PAYLOADS.asteroid.drop.cause,
    };
    const dock = econ[spec.dock];
    const iceEnergy = dock * econ.iceEnergyShare;
    const mod = PAYLOADS.asteroid.volatile;
    const volatile: ResolvedPayloadDrop = {
      ...base,
      impact: {
        damage: base.impact.damage * econ[mod.damage],
        radius: base.impact.radius * econ[mod.radius],
        crater: base.impact.crater,
      },
      scorch: econ[mod.scorch],
      scorchDps: econ.scorchDps,
    };
    const tow = mod.tow;
    rows[size] = {
      hp: econ[spec.hp], tow: econ[spec.tow], dock,
      dockYield: { metal: { alloy: dock, energy: 0 }, ice: { alloy: 0, energy: iceEnergy }, slag: { alloy: 0, energy: 0 } },
      mineHpPerUnit: { metal: dock > 0 ? base.hp / dock : 0, ice: iceEnergy > 0 ? base.hp / iceEnergy : 0, slag: 0 },
      drops: { metal: { ...base, oreValue: dock * econ[PAYLOADS.asteroid.resources.metal.cache] }, ice: base, slag: base },
      volatileDrops: { metal: volatile, ice: volatile, slag: volatile },
      volatileTow: { fuse: econ[tow.fuse], hp: Math.max(1, Math.round(econ[spec.hp] * econ[tow.hpFraction])), damage: econ[tow.damage], radius: econ[tow.radius] },
    };
  }
  return rows;
}
