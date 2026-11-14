/**
 * Ability-tile readiness (enabled, status, cost, cooldown, description) for scan, emplace, ascent, deploy/pack,
 * flare, convert, vent, release and Depths verbs, derived from match rules. Only the team's own snapshot
 * participates; enemy cooldowns are never inferred.
 */
import { CELL, DEPLOY_SPECS, HARDPOINT_KINDS, HOLE_KINDS, isStatKind, STATS, TICK_RATE, UPGRADES, type DeploySpec, type Entity, type HoleKind, type Rules, type UnitKind, type View } from '@agent-command/game/contract';
import { seatSpendable } from '@agent-command/game/economy';
import { depthsCellTip, HOLE_PLURAL, motherLodeTip } from '../text.ts';

/** What an ability tile shows; only the team's own snapshot participates (enemy cooldowns are never inferred). */
export interface AbilityReadiness {
  enabled: boolean;
  /** Short state: the reason when unavailable (cooldown, research, sunlight, energy), otherwise how many are ready. */
  status: string;
  cost: { alloy?: number; energy?: number };
  /** Match-tuned tooltip text; empty when the tool hint already says it. */
  description: string;
  /** Cooldown still to run before the next use: whole seconds and the share of the full cooldown (1 = just used). */
  cooldown?: { left: number; fraction: number };
  /** This match's card label when it differs from the tool's (Backfill that also bridges lava). */
  label?: string;
}

export const WAITING: AbilityReadiness = { enabled: false, status: 'Waiting for match', cost: {}, description: '' };

/** Seconds and share of `total` seconds left until `readyTick`; undefined once ready. */
export function cooldownLeft(readyTick: number, tick: number, total: number): AbilityReadiness['cooldown'] {
  const ticks = readyTick - tick;
  if (ticks <= 0) return undefined;
  return { left: Math.ceil(ticks / TICK_RATE), fraction: total > 0 ? Math.min(1, ticks / TICK_RATE / total) : 1 };
}

/** The team's orbital scan: one shared cooldown and an energy price per use, paid by the Orbit seat (free bank plus its own lane's earmark). */
export function scanReadiness(view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules.orbit;
  if (!view || !rules) return WAITING;
  const cooldown = cooldownLeft(view.res.scanReadyAt, view.tick, rules.scanCooldown);
  const poor = seatSpendable(view.res, view.queue, 'orbit').energy < rules.scanCost;
  return {
    enabled: !cooldown && !poor,
    status: cooldown ? `Cooldown ${cooldown.left}s` : poor ? `Needs ${rules.scanCost} energy` : 'Ready',
    cost: { energy: rules.scanCost },
    description: `Click any point on any plane: reveals radius ${rules.scanRadius} on all four planes for ${rules.scanTime}s. ${rules.scanCooldown}s team cooldown.`,
    ...(cooldown ? { cooldown } : {}),
  };
}


/** Gunships may emplace in this match: `emplace` is on and islands carry a hardpoint. */
export function emplaceAvailable(view: View | undefined): boolean {
  const sky = view?.match?.rules.sky;
  return !!sky?.gunshipEmplaceEnabled && sky.islandHardpoints > 0;
}

/** Own flying Gunships in `units` (the kind the Gun Platform converts from, `HARDPOINT_KINDS`). */
export function emplaceUnits(units: readonly Entity[], view: View): Entity[] {
  return units.filter((e) => e.kind === HARDPOINT_KINDS.gun_platform.from && e.side === view.army && e.plane === 'sky' && !e.hangar && !e.transit);
}

/**
 * The island `unit` can emplace on now, from public data only: one we hold, not being captured, its hardpoint empty
 * (islands[].hardpoint), the unit within rules.sky.captureRadius. `island` restricts the check to that island.
 */
export function emplaceSite(unit: Entity, view: View, island?: Entity): Entity | undefined {
  const radius = view.match?.rules.sky.captureRadius ?? 0;
  let best: Entity | undefined, bestD = Infinity;
  for (const e of island ? [island] : view.entities) {
    if (e.kind !== 'island' || e.side !== view.army || e.state === 'capturing') continue;
    if (view.islands.find((p) => p.id === e.id)?.hardpoint) continue;
    const d = Math.hypot(unit.x - e.x, unit.y - e.y);
    if (d <= radius && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

/** Emplace costs nothing but the Gunship; it is ready while a selected Gunship sits on an island with a free hardpoint. */
export function emplaceReadiness(units: readonly Entity[], view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules;
  if (!view || !rules) return WAITING;
  const ready = emplaceUnits(units, view).some((e) => emplaceSite(e, view));
  return {
    enabled: ready,
    status: ready ? 'Ready' : `Fly a Gunship within ${rules.sky.captureRadius} tiles of an island you hold with a free hardpoint`,
    cost: {},
    description: `Click an island you hold: a selected Gunship within ${rules.sky.captureRadius} tiles lands on its hardpoint for good as a Gun Platform (${rules.stats.gun_platform.hp} HP, keeps its hull share; range +${rules.sky.emplaceRangeBonus}). A live hostile platform blocks capture of its island; capturing the island destroys it. Counts toward the structure cap.`,
  };
}


const ASCENT_GRANTS = Object.values(UPGRADES).filter((u) => u.effects.some((e) => e.kind === 'grant_ability' && e.ability === 'ascend'));
/** Neutral world objects (islands, asteroids, the derelict core) have no stats row. */
const nativeAscent = (kind: Entity['kind']) => isStatKind(kind) && STATS[kind].abilities.includes('ascend');

/** Selected own aircraft that can ascend now or once researched (natively or through a granting upgrade). */
export function ascentUnits(units: readonly Entity[], view: View): Entity[] {
  return units.filter((e) => e.side === view.army && (nativeAscent(e.kind) || ASCENT_GRANTS.some((u) =>
    u.effects.some((effect) => effect.kind === 'grant_ability' && effect.ability === 'ascend' && effect.units.some((k) => k === e.kind)))));
}

/** Aircraft that may start an ascent now: in the Sky, not climbing or raiding, cooldown run. */
export function ascentReady(units: readonly Entity[], view: View): Entity[] {
  return units.filter((e) => e.plane === 'sky' && !(e.transit?.at ?? 0) && !(e.transit?.until ?? 0) && (e.transitReady ?? 0) <= view.tick);
}

export function ascentReadiness(selected: readonly Entity[], view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules.ascent;
  if (!view || !rules) return WAITING;
  const units = ascentUnits(selected, view);
  const unlocked = units.some((e) => nativeAscent(e.kind)) || ASCENT_GRANTS.some((u) => view.research.completed.includes(u.id));
  const ready = unlocked ? ascentReady(units, view) : [];
  const climbing = units.filter((e) => (e.transit?.at ?? 0) > view.tick).length;
  const raiding = units.filter((e) => e.plane === 'orbit' && (e.transit?.until ?? 0) > view.tick);
  const remaining = Math.ceil(Math.max(0, ...raiding.map((e) => ((e.transit?.until ?? 0) - view.tick) / TICK_RATE)));
  const next = Math.min(...units.map((e) => e.transitReady ?? 0).filter((t) => t > view.tick));
  const cooldown = ready.length || !Number.isFinite(next) ? undefined : cooldownLeft(next, view.tick, rules.cooldown);
  const energy = Math.max(1, ready.length) * rules.energy;
  const poor = seatSpendable(view.res, view.queue, 'sky').energy < energy;
  return {
    enabled: unlocked && ready.length > 0 && !poor,
    status: !unlocked ? `Research ${ASCENT_GRANTS.map((u) => u.label).join(' or ')}` : climbing ? `Climbing ×${climbing}` : raiding.length ? `In Orbit ${remaining}s`
      : cooldown ? `Cooldown ${cooldown.left}s` : !ready.length ? 'None ready' : poor ? `Needs ${energy} energy` : `${ready.length}/${units.length} ready`,
    cost: { energy },
    description: `${ASCENT_GRANTS.map((u) => u.label).join(', ')}: climb for ${rules.climb}s, raid Orbit for ${rules.duration}s, then return to Sky. ${rules.cooldown}s cooldown; ${rules.energy} energy per aircraft. Sky retains command.`,
    ...(cooldown ? { cooldown } : {}),
  };
}

/** Depths construction verbs: no cooldown, an alloy price the tile names (never a block: the job waits for funds). */
export function alloyCost(alloy: number, per: string): AbilityReadiness {
  return { enabled: true, status: `${alloy} alloy ${per}`, cost: { alloy }, description: '' };
}

/** May diggers backfill a hole of `kind` this match (rules.depths.backfillKinds: bit i = HOLE_KINDS[i])? */
export const backfillable = (rules: Rules['depths'], kind: HoleKind): boolean => ((rules.backfillKinds >> HOLE_KINDS.indexOf(kind)) & 1) === 1;

/**
 * Backfill / bridge (`bridge`): an alloy price per cell, the hole kinds this match lets diggers fill and, where the
 * match has lava lakes (map.lavaLakes, or lake cells the team knows on an authored map), bridging them; off when
 * neither applies.
 */
export function backfillReadiness(view: View | undefined): AbilityReadiness {
  const match = view?.match;
  if (!view || !match) return WAITING;
  const rules = match.rules.depths;
  const kinds = HOLE_KINDS.filter((kind) => backfillable(rules, kind)).map((kind) => HOLE_PLURAL[kind]);
  const lakes = match.rules.map.lavaLakes.enabled || view.depths.includes(CELL.lake);
  if (!kinds.length && !lakes) return { enabled: false, status: 'No backfill this match', cost: {}, description: 'This match lets diggers backfill no hole kind.' };
  const fill = kinds.length ? `Click a hole over a cell beside your tunnel: the nearest digger fills it back in from below and the Surface there is solid ground again. Fills ${kinds.join(', ')} · ${rules.bridgeCost} alloy and ${rules.bridgeTime}s per cell.` : '';
  const bridge = lakes ? `Click a lava-lake cell beside dry ground or a bridge span: the selected diggers deck it over, up to ${rules.lavaBridgeSpan} cells out · ${rules.lavaBridgeCost} alloy and ${rules.lavaBridgeTime}s per cell.` : '';
  const cost = !kinds.length ? alloyCost(rules.lavaBridgeCost, 'per lava cell') : lakes ? alloyCost(rules.bridgeCost, `per hole cell · ${rules.lavaBridgeCost} per lava cell`) : alloyCost(rules.bridgeCost, 'per cell');
  return { ...cost, description: [fill, bridge].filter(Boolean).join('\n'), ...(lakes ? { label: kinds.length ? 'Backfill / bridge' : 'Bridge lava' } : {}) };
}

/** Mine: never blocked; the tooltip names the Mother Lode and green ore when the match has them (else the tool hint stands). */
export function mineReadiness(view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules;
  const lode = rules ? motherLodeTip(rules) : '';
  const rich = rules?.map.richOre.enabled ? depthsCellTip(CELL.rich, rules) : undefined;
  const extra = [lode, rich && `${rich.title}: ${rich.description}`].filter(Boolean).join('\n');
  return { enabled: true, status: '', cost: {}, description: extra && `Mine nearest known ore and haul it home.\n${extra}` };
}

/** The deploy stance spec of a unit kind (rules/deploy.ts), if it has one. */
export function deploySpecOf(kind: string): DeploySpec | undefined {
  const stance = STATS[kind as UnitKind]?.deploy;
  return stance ? DEPLOY_SPECS[stance] : undefined;
}
/** A unit deployed or deploying (what Pack packs up). */
export const deployedUp = (e: Entity): boolean => {
  const states = deploySpecOf(e.kind)?.states;
  return !!states && (e.state === states[0] || e.state === states[1]);
};
/** Mobile (not deploying, deployed or packing): what Deploy can deploy. */
export const mobile = (e: Entity): boolean => !deploySpecOf(e.kind)?.states.includes(e.state);

/** Selected own living units with a deploy stance on their own plane. */
export function ownDeployable(units: readonly Entity[], view: View): Entity[] {
  return units.filter((e) => e.side === view.army && e.hp > 0 && deploySpecOf(e.kind)?.plane === e.plane);
}

/** Selected own Wardens in the Depths (flares). */
export function ownWardens(units: readonly Entity[], view: View): Entity[] {
  return units.filter((e) => e.kind === 'warden' && e.side === view.army && e.plane === 'depths' && e.hp > 0);
}

/** Deploy (`deploy`) or Pack: how many selected units the order would change; never blocked by a cost. */
export function deployReadiness(units: readonly Entity[], view: View | undefined, deploy: boolean): AbilityReadiness {
  if (!view?.match) return WAITING;
  const own = ownDeployable(units, view);
  const movable = own.filter(deploy ? mobile : deployedUp).length;
  return {
    enabled: movable > 0,
    status: !own.length ? 'Select troopers, tanks, flak or Wardens' : movable ? `${movable}/${own.length} ${deploy ? 'ready' : 'deployed'}` : deploy ? 'Already deployed' : 'None deployed',
    cost: {},
    description: '',
  };
}

/** A selected own Warden may throw a flare now (its own cooldown has run). */
export const flareReady = (e: Entity, view: View): boolean => (e.abilityReady ?? 0) <= view.tick;

/** Flare: one cooldown per Warden; the ring runs to the first selected Warden that is ready again. */
export function flareReadiness(units: readonly Entity[], view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules.depths;
  if (!view || !rules) return WAITING;
  const own = ownWardens(units, view);
  let ready = 0, next = Infinity;
  for (const e of own) {
    if (flareReady(e, view)) ready++;
    else next = Math.min(next, e.abilityReady!);
  }
  const cooldown = !ready && Number.isFinite(next) ? cooldownLeft(next, view.tick, rules.flareCooldown) : undefined;
  return {
    enabled: ready > 0,
    status: !own.length ? 'Select Wardens' : cooldown ? `Cooldown ${cooldown.left}s` : `${ready}/${own.length} ready`,
    cost: {},
    description: `Click a known open tunnel cell within ${rules.flareRange} tiles of a ready Warden: for ${rules.flareReveal}s your team sees the tunnels within ${rules.flareRange} tiles of it (along open tunnel, never through rock). Free · ${rules.flareCooldown}s cooldown per Warden. Anyone who sees the cell sees the flare.`,
    ...(cooldown ? { cooldown } : {}),
  };
}

/**
 * Converting troopers at the team's Drill Yard: needs a built own yard (rules on), and shows the per-Breacher cost and
 * time from the match rules (paid as each trooper goes in, one at a time).
 */
export function convertReadiness(selected: readonly Entity[], view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules;
  if (!view || !rules) return WAITING;
  const cost = rules.stats.breacher;
  const base = { cost: { alloy: cost.alloy, energy: cost.energy }, description: `Each trooper goes in and comes out a Breacher after ${cost.build}s, one at a time; paid as it goes in. Keeps its HP share and queued orders.` };
  if (!rules.surface.breachersEnabled) return { ...base, enabled: false, status: 'Off in this match' };
  const yard = view.entities.some((e) => e.kind === 'drill_yard' && e.side === view.army && e.state !== 'constructing');
  if (!yard) return { ...base, enabled: false, status: 'Needs a built Drill Yard' };
  const troopers = selected.filter((e) => e.kind === 'trooper' && e.side === view.army && e.plane === 'surface' && e.state !== 'converting').length;
  return { ...base, enabled: troopers > 0, status: troopers ? `${troopers} trooper${troopers > 1 ? 's' : ''}` : 'No troopers' };
}

/** Selected own tugs towing the derelict core (what `vent` holds still). */
export function coreTugs(units: readonly Entity[], view: View): Entity[] {
  return units.filter((e) => e.kind === 'tug' && e.side === view.army && e.link !== undefined && view.entities.some((c) => c.id === e.link && c.kind === 'core'));
}

/** Vent: no cooldown; the price is the tug held still while it vents (each vent leaves a higher heat floor) and a pulse that hits allies too. */
export function ventReadiness(units: readonly Entity[], view: View | undefined): AbilityReadiness {
  const rules = view?.match?.rules.orbit;
  if (!view || !rules) return WAITING;
  const tugs = coreTugs(units, view);
  return {
    enabled: tugs.length > 0,
    status: tugs.length ? 'Ready' : 'Tow the core first',
    cost: {},
    description: `The towing tug holds still ${rules.coreVentTime}s (moving restarts it): heat drops to the core's vents so far × ${rules.coreVentFloor} (each vent buys less time) and it pulses ${rules.coreVentDamage} damage to every Orbit unit within ${rules.coreVentRadius} tiles, your own included.`,
  };
}

/** Selected own tugs towing anything (what `release` lets go of). */
export function towingTugs(units: readonly Entity[], view: View): Entity[] {
  return units.filter((e) => e.kind === 'tug' && e.side === view.army && e.link !== undefined);
}

/** Release: free and instant; the tow stays where it is (a rock drifts on, the core rests). */
export function releaseReadiness(units: readonly Entity[], view: View | undefined): AbilityReadiness {
  if (!view) return WAITING;
  const tugs = towingTugs(units, view);
  return {
    enabled: tugs.length > 0,
    status: tugs.length ? 'Ready' : 'Nothing in tow',
    cost: {},
    description: 'The tug lets go of its tow where it is: a rock drifts on (a volatile one disarms), the derelict core stays put (heating out past the hull, cooling in the chamber).',
  };
}
