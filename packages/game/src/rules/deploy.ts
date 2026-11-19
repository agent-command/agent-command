/**
 * Deploy stances: one generic mechanism for a unit that roots itself for a stronger posture (DESIGN §4.1 Warden shield
 * wall, §4.2 Surface wave 1). A unit kind names at most one stance on its STATS row (`deploy`); the `deploy` intent
 * turns it on or off. Every number is a match rule: the spec only names ECON keys.
 *
 * Invariants for every stance: a deploying, deployed or packing unit never moves (any move-type order packs it
 * first; `attack` and `stop` keep it deployed) and never fires during a transition. Phases and their timing are
 * public: anyone who sees the unit sees its state and transition progress.
 * Blocking shield bearers must finish separating from friendly shield bearers before starting a stance.
 */
import type { Econ, EconNumber } from './econ.ts';
import type { Plane, State } from './vocabulary.ts';
import type { Weapon } from './stats.ts';

export const DEPLOY_STANCES = ['walled', 'dug_in', 'siege', 'emplaced', 'unfurled'] as const;
export type DeployStance = (typeof DEPLOY_STANCES)[number];

/** The ECON toggles (boolean rules). */
export type EconFlag = { [K in keyof Econ]: Econ[K] extends boolean ? K : never }[keyof Econ];

export interface DeploySpec {
  /** Plane the stance works on (the `deploy` intent's role); a unit elsewhere (a trooper in the Depths) cannot deploy. */
  plane: Plane;
  /** Match-rule toggle: off, `deploy` is rejected with `blocked` (as every disabled feature). Absent: always on. */
  enabled?: EconFlag;
  /** Deploys by itself wherever the unit comes to rest with no order (and packs for any move, as every stance). */
  auto?: boolean;
  /** Transition durations (ticks; 0 = instant). */
  deployTicks: EconNumber;
  packTicks: EconNumber;
  /** Public entity states while deploying, deployed and packing. */
  states: readonly [State, State, State];
  /** Fires while fully deployed (never during a transition). */
  fires: boolean;
  /**
   * Damage multiplier while fully deployed. With `damageFrom`: only against hits of those weapons (applied per hit in
   * `weaponVs`); without: against all damage (applied in `damage`).
   */
  damageTaken?: EconNumber;
  damageFrom?: readonly Weapon[];
  /** Extra vision (tiles) while fully deployed. */
  vision?: EconNumber;
  /**
   * Weapon reach while fully deployed (tiles to the target's edge, replacing stats range; high ground still adds):
   * against structures and against units; targets nearer than `min` (to their edge) are out of reach. `indirect`:
   * cliffs do not block its fire at targets its team sees. `spire`: an absolute cap against Spire segments instead of
   * `structures`, measured like the segment beam (footprint edge to the shooter's body edge; high ground and cover do
   * not add), so a beam of at least that range answers the shooter wherever it can fire from.
   */
  range?: { structures: EconNumber; units: EconNumber; spire?: EconNumber; min?: EconNumber; indirect: boolean };
  /** Cooldown multiplier while fully deployed (rounded to whole ticks, at least 1). */
  cooldown?: EconNumber;
  /** Depths: in any phase its cell blocks hostile units; own/allied units and fire pass through. */
  blocksCell: boolean;
  /** Own units within `reach` of it, fully deployed: ×`damageTaken` from hostile damage and +`range` weapon range. */
  cover?: { reach: EconNumber; damageTaken: EconNumber; range: EconNumber };
}

export const DEPLOY_SPECS: Record<DeployStance, DeploySpec> = {
  walled: {
    plane: 'depths', enabled: 'wallEnabled', deployTicks: 'wallDeployTicks', packTicks: 'wallUndeployTicks',
    states: ['walling', 'walled', 'unwalling'], fires: true, damageTaken: 'wallDamageTaken', blocksCell: true,
    cover: { reach: 'wallCoverReach', damageTaken: 'wallCoverDamageTaken', range: 'wallCoverRange' },
  },
  dug_in: {
    plane: 'surface', enabled: 'digInEnabled', deployTicks: 'digInTicks', packTicks: 'digOutTicks',
    states: ['digging_in', 'dug_in', 'digging_out'], fires: true, damageTaken: 'dugInDamageTaken',
    damageFrom: ['rifle', 'cannon', 'turret'], vision: 'dugInVision', blocksCell: false,
  },
  siege: {
    plane: 'surface', enabled: 'siegeEnabled', deployTicks: 'siegeDeployTicks', packTicks: 'siegePackTicks',
    states: ['sieging', 'sieged', 'unsieging'], fires: true, blocksCell: false,
    range: { structures: 'siegeRangeStructures', units: 'siegeRangeUnits', spire: 'siegeSpireRange', min: 'siegeMinRange', indirect: true },
  },
  emplaced: {
    plane: 'surface', enabled: 'emplaceEnabled', deployTicks: 'emplaceTicks', packTicks: 'unemplaceTicks',
    states: ['emplacing', 'emplaced', 'unemplacing'], fires: true, blocksCell: false,
    range: { structures: 'emplacedFlakRange', units: 'emplacedFlakRange', indirect: false }, cooldown: 'emplacedFlakCooldown',
  },
  unfurled: {
    plane: 'orbit', deployTicks: 'solarDeployTicks', packTicks: 'solarPackTicks', auto: true,
    states: ['unfurling', 'unfurled', 'furling'], fires: false, blocksCell: false,
  },
};
