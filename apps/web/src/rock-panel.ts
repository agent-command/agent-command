import type { DerelictGeometry, Entity, Plane, Rules, View } from '@agent-command/game/contract';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { tip, type TipContent } from './tooltip.ts';
import { rockFuseLeft } from './world/asteroid.ts';

const SIZE = { pebble: 'Pebble', medium: 'Medium', large: 'Large' } as const;
const RESOURCE = { slag: 'Slag', metal: 'Metal', ice: 'Ice' } as const;

export function rockTip(rock: Entity, rules: Rules, tick: number): TipContent {
  const r = rules.orbit;
  const size = rock.rockSize;
  const resource = rock.resourceType;
  const title = `${size ? SIZE[size] : 'Asteroid'} · ${resource ? RESOURCE[resource] : 'Unidentified'}${rock.volatile === true ? ' · Volatile' : ''}`;
  if (!size || !resource || rock.resourceRemaining === undefined) return { title, description: 'Resources and volatility require local vision of the rock.' };
  const remaining = rock.resourceRemaining;
  const energy = resource === 'ice' ? remaining * r.iceEnergyShare : 0;
  const alloy = resource === 'slag' ? 0 : remaining - energy;
  const tow = size === 'pebble' ? r.pebbleTowSpeed : size === 'large' ? r.largeTowSpeed : r.towSpeed;
  const damage = (size === 'pebble' ? r.pebbleImpactDamage : size === 'large' ? r.largeImpactDamage : r.impactDamage) * (rock.volatile ? r.volatileDamageMultiplier : 1) * rock.hp / rock.maxHp;
  const radius = (size === 'pebble' ? r.pebbleImpactRadius : size === 'large' ? r.largeImpactRadius : r.impactRadius) * (rock.volatile ? r.volatileRadiusMultiplier : 1);
  const delay = size === 'pebble' ? r.pebbleImpactDelay : size === 'large' ? r.largeImpactDelay : r.impactDelay;
  const details = rock.volatile
    ? `Scorches the Surface for ${r.scorchDuration}s at ${r.scorchDps} damage/s. No ore cache.`
    : resource === 'metal' ? `Ground impact leaves ${Math.floor(remaining * r.oreCacheMultiplier)} alloy before the Depths share.`
    : 'No ore cache.';
  const left = rockFuseLeft(rock, tick);
  const fuse = left >= 0 ? `\nInstability fuse: ${Math.ceil(left)}s remaining — drop or dock before detonation.` : '';
  const instability = rock.volatile
    ? `\nTow: ${r.volatileFuse}s fuse · hull ×${r.volatileTowHpFraction}. Destruction or expiry detonates in Orbit: ${r.volatileOrbitDamage} damage · radius ${r.volatileOrbitRadius}, both teams and tug included.`
    : '';
  const mining = resource === 'slag' ? 'Slag cannot be mined or docked for income.'
    : `Mine ${r.tugMineRate}/s · hold ${r.tugHold}. Cargo unloads at your Orbit segment, then resumes this rock. Ice energy bypasses the solar delivery cap. Mining strips hull; damage reduces recoverable resources.`;
  return { title, description: `Remaining / dock: ${alloy.toFixed(1)} alloy · ${energy.toFixed(1)} energy · Tow ×${tow}\n${mining}\nDrop: ${damage.toFixed(1)} damage · radius ${radius} · ${delay}s warning\n${details}${instability}${fuse}` };
}

/** Keyboard-readable observed resource, volatility and fuse chips. */
export function rockInfo(rock: Entity, rules: Rules, tick: number): HTMLElement {
  const info = rockTip(rock, rules, tick);
  const left = rockFuseLeft(rock, tick);
  return h('div', { class: 'unit-chips' },
    tip(h('span', { class: 'unit-chip', 'aria-label': info.title }, icon('asteroid', 16), rock.rockSize ? SIZE[rock.rockSize] : '?'), info),
    tip(h('span', { class: 'unit-chip' }, rock.resourceType ? RESOURCE[rock.resourceType] : '?'), info),
    rock.resourceRemaining !== undefined ? tip(h('span', { class: 'unit-chip' }, `${rock.resourceRemaining.toFixed(1)} remaining`), info) : null,
    rock.volatile === true ? tip(h('span', { class: 'unit-chip' }, icon('volatile_detonation', 16), 'Volatile'), info) : null,
    left >= 0 ? tip(h('span', { class: 'unit-chip', 'aria-label': `Instability fuse: ${Math.ceil(left)} seconds remaining` }, icon('volatile_detonation', 16), `${Math.ceil(left)}s`), info) : null);
}

/** The derelict core's rules in one tooltip; heat and vents only when this team sees the core's cell. */
export function coreTip(core: Entity, rules: Rules): TipContent {
  const r = rules.orbit;
  const known = core.heat !== undefined;
  const state = core.state === 'towed' ? 'under tow' : core.state === 'falling' ? 'falling' : 'resting';
  const rate = core.heatRate === undefined ? '' : ` · ${core.heatRate >= 0 ? '+' : ''}${core.heatRate.toFixed(2)}/s`;
  const left = known && core.state !== 'falling' && (core.heatRate ?? 0) > 0
    ? ` · ~${Math.ceil(Math.max(0, 100 - core.heat!) / core.heatRate!)}s to meltdown at this rate` : '';
  return {
    title: `Derelict core · ${state}${known ? ` · heat ${Math.round(core.heat!)}${rate} · ${core.vents ?? 0} vents${left}` : ''}`,
    description: `${known ? '' : 'Heat and vents require vision of the core.\n'}Holding it pays nothing. Tow it home within ${r.dockRadius} tiles of your Orbit segment to cash it in once: +${r.coreRewardAlloy} alloy, +${r.coreRewardEnergy} energy (past the delivery cap). Radiation ${r.derelictRadiation} damage/s in the chamber.\n`
      + `Out past the hull it heats ${r.coreTransitHeat}/s on S48 (slower on bigger maps) and cools ${r.coreCoolRate}/s back in the chamber. Meltdown at 100: ${r.coreMeltdownDamage} damage · radius ${r.coreMeltdownRadius}; the core is gone.\n`
      + `Vent: tug holds ${r.coreVentTime}s, heat to vents × ${r.coreVentFloor}; a steam pulse damages nearby ships but leaves the core attached. Drop: ${r.coreDropDamage} + ${r.coreDropCoolBonus} × (1 − heat/100) · radius ${r.coreDropRadius} · ${r.coreDropTime}s warning. Regrows ${r.coreRegrowTime}s after it is cashed in, dropped or melted.`,
  };
}

/** Heat and vent chips for a selected derelict core ('?' while its cell is unseen). */
export function coreInfo(core: Entity, rules: Rules): HTMLElement {
  const info = coreTip(core, rules);
  const vents = core.vents === undefined ? '?' : String(core.vents);
  const heat = core.heat === undefined ? '?' : `${Math.round(core.heat)}%`;
  const left = core.heat !== undefined && core.state !== 'falling' && (core.heatRate ?? 0) > 0
    ? `~${Math.ceil(Math.max(0, 100 - core.heat) / core.heatRate!)}s` : '';
  return h('div', { class: 'unit-chips' },
    tip(h('span', { class: `unit-chip${(core.heat ?? 0) >= 80 ? ' hot' : ''}`, 'aria-label': `Heat: ${heat}` }, icon('core_meltdown', 16), heat), info),
    left ? tip(h('span', { class: 'unit-chip', 'aria-label': `Meltdown at current heat rate: ${left}` }, left), info) : null,
    tip(h('span', { class: 'unit-chip', 'aria-label': `Vents: ${vents}` }, icon('vent', 16), vents), info));
}

/**
 * One solar array's output, its factors and repair in a tooltip. `output` (energy/s) is only on our own arrays; the
 * ramp shows on any array we see. Night, distance and shade come from the public sun, our segment and our arrays.
 */
export function arrayTip(e: Entity, rules: Rules): TipContent {
  const r = rules.orbit;
  const ramp = e.ramp === undefined ? undefined : r.solarRampStart + (1 - r.solarRampStart) * e.ramp;
  const state = e.state === 'unfurled' ? 'anchored' : e.state === 'unfurling' ? 'anchoring' : e.state === 'furling' ? 'packing' : 'packed';
  return {
    title: `Solar array · ${state}${e.output !== undefined ? ` · ${e.output.toFixed(2)} energy/s` : ''}${ramp !== undefined ? ` · ramp ×${ramp.toFixed(2)}` : ''}`,
    description: `Anchored where it stops (${r.solarDeployTime}s; packs in ${r.solarPackTime}s to move). Output ${rules.economy.solarRate}/s × light (night ×${r.solarNight}) × ramp (×${r.solarRampStart} → 1 over ${r.solarRampTime}s anchored; a hit of ${r.solarRampHit}+ takes ${Math.round(r.solarRampHitLoss * 100)}% of it) × distance (full within ${r.solarFullRange} tiles of your Orbit segment, ×${r.solarFarFactor} past ${r.solarFarRange}) × shade (−${Math.round(r.solarShadePer * 100)}% per own array within ${r.solarShadeRadius}, at least ×${r.solarShadeFloor}).\n`
      + `Packed (deploy off, or moving) it repairs ${r.arrayRepair} HP/s after ${r.arrayRepairDelay}s without a hit; at your segment it docks for repairs.\n`
      + 'Anchored, its frame lights to the ramp: gold by day, blue at night.',
  };
}

/** Output and ramp chips for a selected solar array (output only on our own). */
export function arrayInfo(e: Entity, rules: Rules): HTMLElement {
  const info = arrayTip(e, rules);
  const ramp = e.ramp === undefined ? '?' : `${Math.round(e.ramp * 100)}%`;
  return h('div', { class: 'unit-chips' },
    e.output !== undefined ? tip(h('span', { class: 'unit-chip', 'aria-label': `Output: ${e.output.toFixed(2)} energy per second` }, icon('energy', 16), `${e.output.toFixed(1)}/s`), info) : null,
    tip(h('span', { class: 'unit-chip', 'aria-label': `Exposure ramp: ${ramp}` }, icon('daylight', 16), ramp), info));
}

/** Context-only legend, driven by the same fog-filtered lists as the map marks. */
export function depositLegend(view: View, rules: Rules, plane: Plane): HTMLElement | null {
  const ore = plane === 'surface' ? view.oreCaches?.some(c => c.alloy > 0) : plane === 'depths' && view.oreCaches?.some(c => (c.below?.alloy ?? 0) > 0);
  const hot = plane === 'surface' && view.scorches?.some(s => s.until > view.tick);
  if (!ore && !hot) return null;
  const r = rules.orbit;
  return h('span', { class: 'unit-chips' },
    ore ? tip(h('span', { class: 'unit-chip', 'aria-label': 'Ore caches' }, icon('metal', 14)), {
      title: 'Ore caches',
      description: plane === 'surface' ? `Stand inside the mint ring uncontested to collect ${r.oreCacheLoad} alloy every ${r.oreCachePeriod}s. Either team can collect it.` : 'Diggers can mine the visible ore beneath the impact. Either team can collect it.',
    }) : null,
    hot ? tip(h('span', { class: 'unit-chip', 'aria-label': 'Scorched ground' }, icon('volatile', 14)), {
      title: 'Scorched ground', description: `Burning, ember-cracked ground deals ${r.scorchDps} damage/s to all Surface units of both teams. BURNING counts down until it cools.`,
    }) : null);
}
