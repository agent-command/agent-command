/**
 * Sky-plane HUD content: structure hints, Aerie/seeder/Drop Ore command-card actions, and island and weather tooltips.
 * Every number comes from the match rules; only own-view entities are commandable.
 */
import { STATS, TICK_RATE, hostileSide, isAircraft, type Entity, type Kind, type Rules, type Side, type View } from '@agent-command/game/contract';
import { seatSpendable } from '@agent-command/game/economy';
import { armyLabel } from './armies.ts';
import type { Intent } from './controls.ts';
import type { CardAction } from './command-card.ts';
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { KIND_LABEL } from './text.ts';
import { tip, type TipContent } from './tooltip.ts';
import { cooldownLeft } from './tools/readiness.ts';
import type { WeatherKind } from './world/weather.ts';
import { mooringDescription, mooringStatus } from './tools/mooring.ts';
import { ruleTables } from './unit-stats.ts';

export function skyStructureHint(kind: Kind, rules: Rules): string {
  const r = rules.sky;
  switch (kind) {
    case 'mooring_tower': return mooringDescription(rules);
    case 'island_mortar': return `Secondary gunner hardpoint, mutually exclusive with Gun Platform and Ore Extractor; leaves the main island slot free. ${rules.stats.island_mortar.dmg} splash damage, radius ${ruleTables(rules).stats.island_mortar.splash}, range ${rules.stats.island_mortar.range}. Slow, telegraphed arcing shells strike a fixed point, not a homing target. Select it and Bombard Surface through the Lens; works while drifting or moored. Friendly splash is dangerous.`;
    case 'ore_extractor': return `Secondary hardpoint, exclusive with Gun Platform and Island Mortar; main slot stays free. Ore-bearing islands have mineral heaps and a diamond in the existing Lens; its ore arc appears only when the reserve is known. Extracts ${r.extractorRate} alloy/s from this island’s finite deposit into its ${r.extractorBuffer}-alloy buffer, costing ${r.extractorUpkeep} energy/s while working. Stops when unpowered, full or depleted. Drop Ore releases the entire buffer as the same neutral Surface ore cache as an asteroid drop: anyone can collect it normally. Nothing is credited directly. Capture transfers undropped cargo. Dismantle frees the hardpoint without refund; the island keeps its reserve and buffer.`;
    case 'aerie': return `One island slot. Forward air production; shelters ${r.aerieCapacity} aircraft from ground fire. Hangared aircraft cannot fight, see, capture or intercept${r.aerieRepairEnabled ? `; while powered it repairs each ${r.aerieRepair} HP/s` : ''}. Launch takes ${r.aerieLaunchTime}s. If the Aerie is destroyed, occupants retain ${r.aerieLossHealth * 100}% of their remaining hull. Airdrop ${r.aerieDropCount} troopers for their normal cost every ${r.aerieDropCooldown}s. Upkeep ${r.aerieUpkeep} energy/s. Select the Aerie to produce there; move aircraft within ${r.aerieDockRadius} tiles, then right-click it to hangar.`;
    case 'storm_seeder': return r.seederEnabled
      ? `One island slot. Select it and Seed: after a public ${r.seederTelegraph}s warning a storm of radius ${r.seederRadius} blows around its island for ${r.seederDuration}s. ${r.seederCost} energy per seed, ${r.seederCooldown}s cooldown from activation, ${r.seederUpkeep > 0 ? `upkeep ${r.seederUpkeep} energy/s only while the storm blows` : 'no upkeep'}; ends early without power. Your own aircraft take ×${r.seededOwnDamage} storm damage inside it. Storms hide aircraft from outside vision and ground/Orbit targeting; scans reveal them.`
      : 'Storm seeding is off in this match.';
    case 'stormcatcher': return `One island slot. Generates ${r.stormcatcherRate} energy/s while inside a storm. No upkeep. Read the public storm forecasts to plan its income.`;
    case 'gun_platform': return `Secondary island hardpoint, exclusive with Island Mortar and Ore Extractor; main slot stays free. An emplaced Gunship whose turret guards its island (range +${r.emplaceRangeBonus}). While it stands, hostile aircraft cannot capture the island; capturing the island destroys it.`;
    default: return '';
  }
}

export function selectedAerie(selection: readonly Entity[], army: View['army']): Entity | undefined {
  return selection.find((e) => e.side === army && e.kind === 'aerie' && e.state !== 'constructing');
}

/** Island reserves/buffers belong to the island, not to the replaceable secondary attachment. */
export function oreIsland(e: Entity | undefined, view: View): Entity | undefined {
  if (e?.kind === 'island') return e;
  if (e?.kind !== 'ore_extractor' || !e.link) return undefined;
  return view.entities.find((island) => island.kind === 'island' && island.id === e.link);
}

export function extractorStatus(extractor: Entity, island: Entity | undefined, rules: Rules): string {
  if (extractor.state === 'constructing') return 'Under construction';
  if (island?.oreRemaining === 0) return 'Depleted · drop stored ore or dismantle';
  if (island?.oreBuffer !== undefined && island.oreBuffer >= rules.sky.extractorBuffer) return 'Buffer full · Drop Ore to resume';
  if (extractor.extractorPowered === false) return 'Unpowered · extraction paused';
  if (extractor.state === 'mining') return `Extracting · ${rules.sky.extractorRate} alloy/s into buffer · ${rules.sky.extractorUpkeep} energy/s`;
  return 'Idle';
}

export function islandOreInfo(e: Entity, view: View, rules: Rules): HTMLElement | undefined {
  const island = oreIsland(e, view);
  if (!island || !(island.oreCapacity && island.oreCapacity > 0)) return undefined;
  const extractor = e.kind === 'ore_extractor' ? e
    : view.entities.find((part) => part.kind === 'ore_extractor' && part.link === island.id);
  return h('div', { class: 'unit-chips', 'aria-label': 'Island ore' },
    tip(h('span', { class: 'unit-chip', 'aria-label': 'Ore reserve', ...(island.oreRemaining === undefined ? {} : { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': island.oreCapacity, 'aria-valuenow': island.oreRemaining }) }, icon('alloy', 14),
      `${island.oreRemaining === undefined ? '?' : island.oreRemaining.toFixed(1)}/${island.oreCapacity} ore`),
    { title: 'Finite island deposit', description: island.oreRemaining === undefined ? 'Current reserve is unknown. Public mineral markings reveal only the initial deposit, not depletion.' : 'Extraction consumes this deposit permanently. Ownership changes and rebuilding do not replenish it.' }),
    island.oreBuffer === undefined ? null : tip(h('span', { class: 'unit-chip', role: 'meter', 'aria-label': 'Buffered ore', 'aria-valuemin': 0, 'aria-valuemax': rules.sky.extractorBuffer, 'aria-valuenow': island.oreBuffer }, icon('drop_ore', 14), `${island.oreBuffer.toFixed(1)}/${rules.sky.extractorBuffer} buffered`),
      { title: 'Undropped cargo', description: 'Stored on the island, not credited to your army. Drop the entire buffer as a normal neutral Surface ore cache; anyone may collect it. Capture transfers undropped cargo.' }),
    extractor ? h('span', { class: 'muted small', 'aria-label': 'Extractor status' }, extractorStatus(extractor, island, rules)) : null);
}

/**
 * The Sky's structure and hangar orders as command-card actions. Own-view entities only; sheltered aircraft stay
 * commandable without being drawn on the map. Airdrops and seeding are abilities (cooldown, cost); the rest
 * are commands. Surface Mooring Towers have their own targeted Lens tool and release command.
 */
export function skyActions(view: View, rules: Rules, selection: readonly Entity[], act: (intents: Intent[]) => void): CardAction[] {
  const own = selection.filter((e) => e.side === view.army);
  const aerie = selectedAerie(own, view.army);
  const aircraft = own.filter((e) => e.plane === 'sky' && isAircraft(e.kind) && !e.hangar);
  const candidates = view.entities.filter((e) => e.side === view.army && e.kind === 'aerie' && e.state !== 'constructing').map((target) => ({
    target,
    count: view.entities.filter((e) => e.hangar === target.id).length,
    far: aircraft.some((e) => !!e.transit || Math.hypot(e.x - target.x, e.y - target.y) > rules.sky.aerieDockRadius),
  }));
  const occupants = view.entities.filter((e) => e.side === view.army && e.hangar === aerie?.id && e.hangar !== undefined);
  const seeder = rules.sky.seederEnabled ? own.find((e) => e.kind === 'storm_seeder' && e.state !== 'constructing') : undefined;
  const ready = own.filter((e) => e.state === 'hangared');
  const seconds = (tick = 0) => Math.max(0, Math.ceil((tick - view.tick) / TICK_RATE));
  const dropAlloy = STATS.trooper.alloy * rules.sky.aerieDropCount, dropEnergy = STATS.trooper.energy * rules.sky.aerieDropCount;
  // Airdrop and seeding are the Sky seat's direct spends: the free bank plus its own lane's earmark, never another lane's.
  const spendable = seatSpendable(view.res, view.queue, 'sky');
  const poor = spendable.alloy < dropAlloy || spendable.energy < dropEnergy;
  const actions: CardAction[] = [];
  const action = (id: string, group: CardAction['group'], rank: number, name: IconName, label: string, description: string, intents: Intent[], status = '', disabled = false, extra: Partial<CardAction> = {}) => {
    actions.push({
      id, group, rank, icon: name, label, disabled, ...extra,
      tip: { title: label, description, status, ...(extra.cost ? { cost: extra.cost } : {}) },
      run: () => { if (!disabled) act(intents); },
    });
  };
  if (aircraft.length) for (const { target, count, far } of candidates) {
    const status = target.state === 'idle' ? 'Unpowered' : count + aircraft.length > rules.sky.aerieCapacity ? 'Not enough free berths' : far ? `Move all selected aircraft within ${rules.sky.aerieDockRadius} tiles first` : '';
    action(`sky:hangar:${target.id}`, 'commands', 6, 'hangar', candidates.length > 1 ? `Hangar at Aerie ${target.id}` : 'Hangar at Aerie', `Shelter selected aircraft. ${count}/${rules.sky.aerieCapacity} berths occupied. Move within ${rules.sky.aerieDockRadius} tiles before docking.`, [{ kind: 'hangar', units: aircraft.map((e) => e.id), target: target.id }], status, !!status);
  }
  if (ready.length) action('sky:launch', 'commands', 7, 'launch', 'Launch selected aircraft', `Launch takes ${rules.sky.aerieLaunchTime}s.`, [{ kind: 'launch', units: ready.map((e) => e.id) }]);
  if (aerie) {
    const docked = occupants.filter((e) => e.state === 'hangared');
    action('sky:launch-all', 'commands', 7, 'launch', 'Launch all aircraft', `Launch takes ${rules.sky.aerieLaunchTime}s. Hangar occupancy ${occupants.length}/${rules.sky.aerieCapacity}.`, [{ kind: 'launch', units: docked.map((e) => e.id) }], docked.length ? '' : 'No hangared aircraft', !docked.length, { badge: `${occupants.length}/${rules.sky.aerieCapacity}` });
    const repairing = rules.sky.aerieRepairEnabled && aerie.state !== 'idle';
    for (const unit of occupants) action(`sky:launch:${unit.id}`, 'commands', 3, unit.kind as IconName, `Launch ${KIND_LABEL[unit.kind]} ${unit.id}`, `${unit.hp}/${unit.maxHp} hull · ${unit.state}${repairing && unit.hp < unit.maxHp ? ` · repairing ${rules.sky.aerieRepair} HP/s` : ''}`, [{ kind: 'launch', units: [unit.id] }], unit.state === 'launching' ? `${seconds(unit.ready)}s to launch` : '', unit.state !== 'hangared');
    const cooldown = cooldownLeft(aerie.ready ?? 0, view.tick, rules.sky.aerieDropCooldown);
    action('sky:airdrop', 'abilities', 11, 'airdrop', 'Airdrop troopers', `Deploy ${rules.sky.aerieDropCount} troopers to the Surface below in ${rules.sky.aerieDropTravel}s. Cooldown ${rules.sky.aerieDropCooldown}s. Blocked ground or a full population prevents landing.`, [{ kind: 'airdrop', aerie: aerie.id }],
      aerie.state === 'idle' ? 'Unpowered' : cooldown ? `Ready in ${cooldown.left}s` : poor ? 'Insufficient resources' : '', aerie.state === 'idle' || !!cooldown || poor,
      { cost: { alloy: dropAlloy, energy: dropEnergy }, ...(cooldown ? { cooldown } : {}) });
  }
  if (seeder) {
    const r = rules.sky;
    const until = seeder.activeUntil ?? 0;
    const active = until > view.tick;
    const forms = until - r.seederDuration * TICK_RATE;
    const cooldown = active ? undefined : cooldownLeft(seeder.ready ?? 0, view.tick, r.seederCooldown);
    const poor = spendable.energy < r.seederCost;
    const status = active ? forms > view.tick ? `Storm forms in ${seconds(forms)}s` : `Storm blows ${seconds(until)}s` : cooldown ? `Ready in ${cooldown.left}s` : poor ? `Needs ${r.seederCost} energy` : '';
    action('sky:seed', 'abilities', 11, 'seed', 'Seed storm', skyStructureHint('storm_seeder', rules), [{ kind: 'seed', seeder: seeder.id }],
      status, active || !!cooldown || poor, { on: active, cost: { energy: r.seederCost }, ...(cooldown ? { cooldown } : {}) });
  }
  const selected = own.length === 1 ? own[0] : undefined;
  const island = oreIsland(selected, view);
  if (island?.side === view.army && (island.oreCapacity ?? 0) > 0) {
    const buffer = island.oreBuffer;
    action('sky:drop-ore', 'abilities', 12, 'drop_ore', 'Drop Ore',
      'Drop all buffered ore at the nearest legal Surface cache site below. This uses the normal neutral asteroid ore cache and collection mechanism; any army can collect it. No direct alloy credit.',
      [{ kind: 'drop_ore', island: island.id }], buffer === undefined ? 'Cargo unknown' : buffer <= 0 ? 'Buffer empty' : `${buffer.toFixed(1)} alloy buffered`,
      buffer === undefined || buffer <= 0, buffer === undefined ? {} : { badge: buffer.toFixed(1) });
  }
  return actions;
}

/**
 * Hover tip for an island: who holds it, its one slot (the public structure there, or a storm hiding it), capture
 * progress when it is known, and what attacking it will do.
 */
export function islandTip(island: Entity, view: View, rules: Rules): TipContent {
  const whose = (side: Side) => side === view.army ? 'yours' : side === 'neutral' ? 'nobody' : armyLabel(view.match!, side);
  const slot = island.link ? view.entities.find((e) => e.id === island.link) : undefined;
  const lines: string[] = [];
  const building = slot?.progress !== undefined && slot.progress < 1;
  if (slot) {
    const built = building ? `, building ${Math.round(slot.progress! * 100)}%` : '';
    lines.push(`Slot 1/1: ${KIND_LABEL[slot.kind]} (${whose(slot.side)}${built}). ${skyStructureHint(slot.kind, rules)}`);
  } else lines.push(island.link ? 'Slot 1/1: hidden by a storm.' : 'Slot 0/1: empty.');
  const path = view.islands.find((p) => p.id === island.id);
  if ((island.oreCapacity ?? 0) > 0) {
    lines.push(island.oreRemaining === undefined ? 'Ore-bearing island · current reserve unknown.'
      : `Finite ore: ${island.oreRemaining.toFixed(1)}/${island.oreCapacity} remaining${island.oreRemaining === 0 ? ' · depleted' : ''}.`);
    if (island.oreBuffer !== undefined) lines.push(`Buffered ore: ${island.oreBuffer.toFixed(1)}/${rules.sky.extractorBuffer}. Drop Ore creates a neutral Surface cache; anyone may collect it.`);
  }
  const mount = path?.hardpoint;
  if (rules.sky.islandHardpoints > 0) {
    if (mount) lines.push(`Hardpoint: ${KIND_LABEL[mount.kind]} (${whose(mount.side)}).`);
    else lines.push(`Hardpoint: no visible occupant (empty or concealed). With a free hardpoint, the holder can build an Island Mortar${(island.oreCapacity ?? 0) > 0 ? ' or Ore Extractor' : ''}${rules.sky.gunshipEmplaceEnabled ? ', or emplace a Gunship' : ''}; the main slot stays independent. A concealed hostile hardpoint can block capture.`);
  }
  const pct = island.progress === undefined ? '' : ` ${Math.round(island.progress * 100)}%`;
  if (island.state === 'contested') lines.push(`Contested: ${mount ? `its ${KIND_LABEL[mount.kind]} or rival aircraft hold off the capture` : 'rival aircraft or a concealed hardpoint block capture'}${pct ? ` at${pct}` : ''}.`);
  else if (island.state === 'capturing' && pct) lines.push(`Being captured:${pct}.${slot && !building && island.side !== 'neutral' ? ` The capture drains its ${KIND_LABEL[slot.kind]}.` : ''}`);
  else if (pct) lines.push(`Capture fading:${pct}.`);
  if (island.mooringState || (island.mooringReadyAt ?? 0) > view.tick) lines.push(`${mooringStatus(island, view)}. Mooring does not change ownership or building access.`);
  const hostile = slot && hostileSide(view.match!, view.army, slot.side);
  const r = rules.sky;
  lines.push(hostile
    ? `Right-click with a selection to attack its structure. Capturing takes ${building ? r.captureTime : r.captureStructureTime}s uncontested${building ? '' : ' and drains the structure as it goes'}.`
    : mount && hostileSide(view.match!, view.army, mount.side)
      ? `Right-click with a selection to attack its ${KIND_LABEL[mount.kind]}; no capture while it stands.`
      : `Right-click with air units to capture it (${r.captureTime}s uncontested).`);
  return { title: `Island · held by ${whose(island.side)}`, description: lines.join(' ') };
}

/** What each kind of public Sky weather does: the hover tip on the weather itself and the legend's text. */
export function weatherTip(kind: WeatherKind, rules: Rules): TipContent {
  const r = rules.sky;
  const storm = `Aircraft inside: speed ×${r.stormSpeed}, ${r.stormDps} damage/s; hidden from outside vision, flak, turrets and Orbit fire (scans reveal them).${r.stormEvadeEnabled ? ' Idle aircraft step out on their own unless you sent them in or set them to hold.' : ''}`;
  switch (kind) {
    case 'storm': return { title: 'Storm', description: `${storm} Effects scale with the cloud's strength while it forms and breaks apart. Drifts along its public forecast, mirrored across the map; lightning marks the full-strength mature stage.` };
    case 'forecast': return { title: 'Gathering storm', description: 'Faint gathering clouds mark an upcoming natural storm. No storm effects yet; the clouds billow into a storm at the forecast start, then drift and break apart.' };
    case 'seeded': return { title: 'Seeded storm', description: `${storm} Raised by a Storm Seeder for up to ${r.seederDuration}s; ends early if the Seeder loses power. Aircraft of the seeding alliance take ×${r.seededOwnDamage} storm damage inside it.` };
    case 'seeding': return { title: 'Storm brewing', description: `Public warning: a Storm Seeder's storm forms here once the ${r.seederTelegraph}s telegraph runs out, radius ${r.seederRadius}, lasting ${r.seederDuration}s. No storm effects yet; move aircraft out or in.` };
    case 'fog': return { title: 'Fog bank', description: `Vision ×${r.fogVision} for Sky observers inside, including sight into the planes above and below. Drifts on a fixed public path.` };
    case 'jet': return { title: 'Wind lane', description: `Aircraft flying with the wind streaks: speed up to ×${r.jetWith}; against them ×${r.jetAgainst}; across, unchanged.` };
  }
}

export function weatherLegend(rules: Rules): HTMLElement {
  const legend = (kind: WeatherKind, label: string, name: IconName, title: string) =>
    tip(h('span', { tabindex: 0, 'aria-label': label }, icon(name, 16)), { title, description: `${weatherTip(kind, rules).description} Hover the weather for details.` });
  return h('span', { class: 'abil' },
    legend('storm', 'Storms', 'storm', 'Storms · faint gathering clouds, billowing growth, mature lightning, breaking wisps'),
    legend('jet', 'Wind lanes', 'wind', 'Wind lanes · white wind streaks'),
    legend('fog', 'Fog banks', 'fog', 'Fog banks · low white mist'));
}
