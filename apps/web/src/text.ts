/** Client-authored labels for closed-vocabulary values. Nothing here comes from the network. */
import { CELL, PLANES, resolveUpgrade, TICK_RATE, UPGRADES, type AlertKind, type ArmyId, type Armor, type BuildSiteError, type Entity, type GameEvent, type HoleKind, type Kind, type Macro, type MatchData, type Plane, type QueueReason, type Rules, type SupportNeed, type TerrainPreset, type UpgradeId, type Weapon, type WeaponMount } from '@agent-command/game/contract';
import type { SignalState } from 'playerthree/signals';
import { armyLabel } from './armies.ts';
import { postName } from './post-tip.ts';
import type { ReturnArrival } from './world/returns.ts';
import type { SignalEntry } from './signals.ts';

export const KIND_LABEL: Record<Kind, string> = {
  digger: 'Digger',
  sapper: 'Sapper',
  trooper: 'Trooper',
  tank: 'Tank',
  flak: 'Flak',
  interceptor: 'Interceptor',
  bomber: 'Bomber',
  gunship: 'Gunship',
  solar: 'Solar array',
  tug: 'Tug',
  lancer: 'Lancer',
  skiff: 'Skiff',
  bastion: 'Bastion',
  warden: 'Warden',
  breacher: 'Breacher',
  spire: 'Spire',
  shaft: 'Shaft',
  turret: 'Turret',
  mooring_tower: 'Mooring Tower',
  ore_extractor: 'Ore Extractor',
  relay: 'Relay',
  aerie: 'Aerie',
  storm_seeder: 'Storm Seeder',
  stormcatcher: 'Stormcatcher',
  headframe: 'Headframe',
  bulkhead: 'Bulkhead',
  lava_bridge: 'Lava bridge',
  geothermal: 'Geothermal tap',
  gun_platform: 'Gun Platform',
  island_mortar: 'Island Mortar',
  drill_yard: 'Drill Yard',
  island: 'Sky island',
  asteroid: 'Asteroid',
  core: 'Derelict core',
  post: 'Forward post',
};

export const KIND_HINT: Partial<Record<Kind, string>> = {
  digger: 'Tunnels, mines ore, fortifies the rock walls of your tunnels',
  sapper: 'Undermines the surface: collapse in 10 s',
  trooper: 'Infantry; can transfer to the Depths',
  tank: 'Heavy surface armour',
  flak: 'Anti-air from the ground',
  interceptor: 'Air superiority; shoots down asteroids',
  bomber: 'Hits surface targets from the sky',
  gunship: 'Armoured sky brawler; shreds interceptors up close, outlasts them under flak: escort bombers',
  solar: 'Energy in daylight; chase the sun',
  tug: 'Mine metal and ice, haul cargo home; or tow and deorbit whole asteroids and the derelict core',
  lancer: 'Long-range beam frigate; attacks Orbit units and the Orbit Spire segment',
  skiff: 'Fast, light orbital fighter; closes to short range',
  bastion: 'Shielded escort; rapid point defence against Orbit enemies and asteroid payloads',
  warden: 'Depths sentinel: shield wall admits friendly traffic but blocks enemies without packing; throws flares and fortifies tunnel walls',
  breacher: 'Close-range flamer: ×2 vs dug-in troopers, burns structures; converted from a trooper at a Drill Yard',
  shaft: 'Ore drop-off + troop transfer; when the Depths root is destroyed, select a built shaft and open Units to queue replacement diggers',
  turret: 'Static surface defence',
  mooring_tower: 'Surface Tesla tower: catch one visible island of any owner, lower it beneath Sky traffic while powered, then release. No capture, building rights or Surface visibility',
  relay: '+energy delivery, vision below',
  aerie: 'Forward air production, sheltered hangar and trooper airdrops',
  storm_seeder: 'Powered weather engine: seed a storm around its island on demand (telegraphed, energy per seed, cooldown)',
  stormcatcher: 'Generates energy while its island is inside a storm',
  headframe: 'On a lode outcrop: opens the ore pocket below, its drop-off and a small alloy trickle',
  bulkhead: 'Tunnel gate: your units pass, enemies must break it',
  lava_bridge: 'Deck over a lava lake: every army crosses it; combat or a sapper charge drops it back into the lava',
  geothermal: 'Harvests sealed magma for local energy, bypassing the solar delivery cap; one tap per pocket',
  gun_platform: 'Emplaced Gunship on an island hardpoint: guards the island, blocks hostile capture until destroyed',
  island_mortar: 'Secondary island hardpoint: slow, telegraphed arcing splash against visible Surface targets. Drifting or moored; shares the hardpoint with Gun Platform and Ore Extractor, not the main building slot',
  ore_extractor: 'Secondary hardpoint: powered extraction of finite island ore into an onboard buffer. Drop Ore creates the normal neutral Surface cache; collecting it earns alloy. No passive income',
  drill_yard: 'Converts troopers into Breachers, one at a time; one per team',
};

export const TERRAIN_LABEL: Record<TerrainPreset, string> = {
  open: 'Open', ridges: 'Ridges', canyons: 'Canyons', chokepoint: 'Chokepoint',
  archipelago: 'Archipelago', fortress: 'Fortress', rivers: 'Rivers', highlands: 'Highlands',
};

/** Compact plane-chip labels for the per-plane alerts. */
export const ALERT_LABEL: Record<AlertKind, string> = {
  segment_threatened: 'Spire',
  sudden_death: 'Sudden death',
  rocks: 'Rocks',
  core_lifted: 'Core out',
  radiation: 'Radiation',
  storm_forming: 'Storm',
  storm_growing: 'Growing',
  storm_peak: 'Peak',
  storm_breaking: 'Breaking',
  island_contested: 'Island',
  post_contested: 'Post',
  charge_under: 'Charge under',
  drop: 'Drop',
  lode_critical: 'Lode',
  intruder: 'Intruders',
  wall_dig: 'Digging in',
  charge: 'Charge',
  breach: 'Breach',
  tremor: 'Tremor',
  magma: 'Magma',
};

/** Plane-chip tooltip lines; `{in}` is replaced by the countdown. */
export const ALERT_TEXT: Record<AlertKind, string> = {
  segment_threatened: 'Our Spire segment here is under attack or low · ask the team to defend it',
  sudden_death: 'Sudden death in {in} · every Spire then takes extra damage (rocks excepted): push',
  rocks: 'Next rocks in {in}',
  core_lifted: 'Derelict core towed out of the ruin · meltdown or strike to come',
  radiation: 'Our ships are taking radiation in the derelict chamber · leave on an open window',
  storm_forming: 'Storm forms in {in}',
  storm_growing: 'Storm growing · peak in {in}',
  storm_peak: 'Storm at peak · breaks up in {in}',
  storm_breaking: 'Storm breaking up · clear in {in}',
  island_contested: 'Enemy capturing or contesting your island',
  post_contested: 'Enemy capturing or contesting your forward post',
  charge_under: 'Enemy charge under our ground blows in {in} · step clear',
  drop: 'Drop lands in {in}',
  lode_critical: 'Mother Lode erupts in {in} · get your miners out of its chamber',
  intruder: 'Enemies in your tunnels near home',
  wall_dig: 'Enemy digging into your wall',
  charge: 'Enemy charge blows in {in}',
  breach: 'Enemy troopers digging up',
  tremor: 'Tremors beneath you',
  magma: 'Magma flood cools in {in}',
};

/** Plane-chip tooltip when a plane has nothing pending. */
export const ALERT_QUIET: Record<Plane, string> = {
  orbit: 'No rocks scheduled',
  sky: 'Islands quiet · no storm forecast',
  surface: 'No charges under us or drops incoming',
  depths: 'Quiet below: no intruders, digging in, charges, tremors or magma',
};

/** Team support requests (the `need` of `request_support`): chip labels and the Request buttons. */
export const NEED_LABEL: Record<SupportNeed, string> = {
  troops: 'Troops',
  air_cover: 'Air cover',
  scan: 'Scan',
  flak: 'Flak',
  bombers: 'Bombers',
  escort: 'Escort',
  collapse: 'Collapse',
  drop: 'Drop',
  capture: 'Capture',
  defend: 'Defend',
};

/** A request on a plane chip (its tooltip line): `{from}` asks, `{need}`, `{in}` until it expires; then who took it. */
export const REQUEST_ALERT = { text: '{from} needs {need} · {in} left', taken: '{by} on it', take: 'click to take it' } as const;

/** A request's later states in the feed, after its need ("Troops done"); `{by}` is the plane that took it. */
export const SIGNAL_STATE_TEXT: Record<SignalState, string> = {
  submitted: '',
  working: '{by} on it',
  completed: 'done',
  rejected: 'declined',
  failed: 'failed',
  canceled: 'cancelled',
  expired: 'expired',
};

const SIGNAL_SEVERITY: Record<SignalState, Severity> = {
  submitted: 'warn', working: 'info', completed: 'good', rejected: 'bad', failed: 'bad', canceled: 'info', expired: 'info',
};

/** Who a request asks: a plane or the whole team. */
export const signalTo = (to: string): string => (to === 'team' ? 'Team' : PLANE_NAME[to as Plane]);

/** One feed line for a request in its current state: `text` beside the from → to icons, `full` names the planes. */
export function signalText(e: SignalEntry): { text: string; full: string; sev: Severity } {
  const need = `${NEED_LABEL[e.need]}${e.count ? ` ×${e.count}` : ''}`;
  const state = SIGNAL_STATE_TEXT[e.state].replace('{by}', e.by ? PLANE_NAME[e.by] : signalTo(e.to));
  const text = state ? `${need} ${state}` : need;
  return { text, full: `${PLANE_NAME[e.from]} → ${signalTo(e.to)}: ${text}`, sev: SIGNAL_SEVERITY[e.state] };
}

/** Plane-chip tooltip lines for public schedule entries no alert covers; `{in}`/`{for}` are countdowns. */
export const SCHEDULE_TEXT = {
  derelict_open: 'Derelict gates open in {in} · for {for}',
  derelict_open_now: 'Derelict gates open · close in {for}',
  core_regrows: 'New derelict core in {in}',
} as const;

/** Order names in error toasts. */
export const VERB_LABEL: Record<string, string> = {
  attack: 'Attack',
  breach: 'Breach',
  rail: 'Lay rail',
  bridge: 'Backfill / bridge',
  undermine: 'Undermine',
  transfer: 'Transfer',
  research: 'Research',
  ascend: 'Ascend',
  hangar: 'Hangar',
  launch: 'Launch',
  airdrop: 'Airdrop',
  moor: 'Moor island',
  unmoor: 'Release island',
  drop_ore: 'Drop Ore',
  dismantle: 'Destroy Structure',
  seed: 'Seed storm',
  emplace: 'Emplace',
  queue_add: 'Queue',
  queue_cancel: 'Cancel',
  queue_move: 'Reorder',
  fortify: 'Fortify',
  deploy: 'Deploy',
  flare: 'Flare',
  signal: 'Request',
  signal_update: 'Answer',
  grapple: 'Grapple',
  mine_asteroid: 'Mine asteroid',
  deorbit: 'Deorbit',
  vent: 'Vent',
};

/** Verb-specific explanations of closed error codes (fallback: ERROR_TEXT). */
export const VERB_ERROR: Record<string, Record<string, string>> = {
  hangar: {
    invalid_target: 'Move the selected aircraft close to an own Aerie before docking',
    queue_full: 'Not enough free hangar berths for this selection',
    blocked: 'The Aerie must be complete and powered',
  },
  launch: { blocked: 'Select hangared aircraft that are not already launching' },
  airdrop: {
    blocked: 'Needs power, a ready cooldown and clear ground below',
    queue_full: 'Not enough population space for the airdrop',
    cannot_afford: 'Not enough resources for the trooper squad',
  },
  moor: {
    blocked: 'Needs a complete tower, an available island and a safe catch below Sky traffic',
    invalid_target: 'Select your own Mooring Tower and a visible island whose route passes within catch range',
    cooldown: 'The island is held, rising to flight level or recovering from release',
    cannot_afford: 'Not enough energy to maintain the mooring field',
  },
  unmoor: { invalid_target: 'Select your own tower with a pending catch or held island' },
  drop_ore: {
    invalid_target: 'Select an island you hold or its Ore Extractor',
    blocked: 'Needs buffered ore and a legal Surface cache site below',
  },
  dismantle: { invalid_target: 'That structure is no longer available', not_your_unit: 'You can only destroy your own structures', wrong_plane: 'Select a structure on this plane', wrong_kind: 'Spire segments, map objectives and mobile units cannot be demolished', blocked: 'Cancel unfinished construction through its queue entry instead' },
  seed: {
    blocked: 'Needs seeding on in this match, a complete Storm Seeder and power',
    invalid_target: 'Select one of your Storm Seeders',
    cooldown: 'That Storm Seeder is seeding or on cooldown',
    cannot_afford: 'Not enough energy to seed a storm',
  },
  emplace: {
    blocked: 'Emplacing is off in this match',
    not_held: 'Emplace on an island your army holds',
    occupied: 'That island’s hardpoint is taken, or the island is being captured',
    invalid_target: 'Move the Gunship onto an island you hold first',
    queue_full: 'Structure cap reached',
  },
  attack: {
    no_path: 'No way into range of that target (holes cut it off)',
  },
  breach: {
    invalid_target: 'Breach from a tunnel cell under open ground',
    wrong_kind: 'Only troopers in the Depths can breach',
    no_path: 'Troopers cannot reach that tunnel',
    blocked: 'The surface above is blocked (cliff or an open hole)',
    occupied: 'A structure stands on the surface above',
  },
  rail: {
    invalid_target: 'Rails go on known tunnel cells',
    wrong_kind: 'Only diggers lay rail',
    cannot_afford: 'Not enough alloy for the rail',
    no_path: 'No tunnel route to there',
  },
  bridge: {
    invalid_target: 'Pick a hole this match lets diggers backfill, or a known lava-lake cell beside dry ground or a bridge span',
    wrong_kind: 'Only diggers backfill holes and bridge lava',
    cannot_afford: 'Not enough alloy',
  },
  undermine: {
    invalid_target: 'Plant charges on tunnel cells',
    wrong_kind: 'Only sappers plant charges',
  },
  fortify: {
    invalid_target: 'Fortify rock walls of your own tunnels (never tunnel cells)',
    not_adjacent: 'That rock does not border one of your tunnels',
    cannot_afford: 'Not enough alloy to fortify',
  },
  deploy: { wrong_kind: 'Only troopers, tanks, flak and Wardens deploy', blocked: 'That stance is switched off, or overlapping Wardens need room to deploy' },
  flare: {
    blocked: 'That Warden’s flare is still on cooldown',
    invalid_target: 'Throw flares onto a known open tunnel cell within range',
    wrong_kind: 'Only Wardens throw flares',
  },
  grapple: { invalid_target: 'Grapple a drifting asteroid or the resting derelict core' },
  mine_asteroid: { invalid_target: 'Choose a visible drifting metal or ice asteroid with resources remaining' },
  deorbit: {
    not_held: 'Select a tug that is towing',
    invalid_target: 'Out of deorbit range — and the core drops only from beyond the derelict hull',
  },
  vent: { not_held: 'Only tugs towing the derelict core can vent it' },
  queue_add: {
    queue_full: 'Build queue full (team or seat limit)',
    invalid_target: 'Cannot build there',
    not_visible: 'That tile is not visible',
    not_held: 'Your team does not hold that island',
    occupied: 'Something already stands there',
    blocked: 'That tile is blocked',
    segment_destroyed: 'That plane’s Spire segment is destroyed',
    no_lode: 'Headframes need a lode outcrop',
    out_of_radius: 'Outside your build radius — expand with a Shaft or Headframe',
    no_build_zone: 'Too close to the enemy Spire',
    wrong_kind: 'Select a digger to build Depths structures',
    not_adjacent: 'The digger needs an adjacent tunnel to work from',
    no_path: 'The digger cannot reach the work site',
  },
  queue_cancel: { invalid_target: 'That entry is no longer queued' },
  queue_move: { invalid_target: 'That entry is no longer queued' },
  signal: {
    disabled: 'Team requests are off in this match',
    unsupported: 'No teammate answers that',
    too_many_open: 'Too many open requests — wait for answers',
  },
  signal_update: {
    unknown_signal: 'That request is gone',
    not_recipient: 'A teammate already took it',
    closed: 'That request is already closed',
  },
};

/** Pointer tips for a build ghost the build radius refuses. */
export const RADIUS_TIP: Record<BuildSiteError, { title: string; description: string }> = {
  out_of_radius: { title: 'Outside your build radius', description: 'Build within reach of your Spire or a completed Shaft or Headframe. Turrets add no radius.' },
  no_build_zone: { title: 'Too close to the enemy Spire', description: 'Nothing may be built near the enemy Spire, even inside your radius.' },
};

/** Controllers as plain words, e.g. the "bot" of "Sky bot". */
export const CONTROLLER_WORD: Record<string, string> = { human: 'human', agent: 'agent', policy: 'policy', bot: 'bot', none: 'seat' };

/** A seat and its controller: "Sky bot", "Surface human". */
export function seatName(plane: Plane, controller: string | undefined): string {
  return `${PLANE_NAME[plane]} ${CONTROLLER_WORD[controller ?? 'none'] ?? controller}`;
}

/** Why a team build queue entry is not building yet. */
export const QUEUE_REASON_TEXT: Record<QueueReason, string> = {
  funds: 'saving',
  producer: 'producer unavailable',
  segment_destroyed: 'segment destroyed',
  pop_cap: 'pop cap',
  structure_cap: 'structure cap',
  occupied: 'site occupied',
  blocked: 'site blocked',
  not_held: 'island lost',
  no_builder: 'no free digger',
  site_unseen: 'site out of sight',
  enemy_near: 'enemy near the segment',
  lane: 'waiting its lane turn',
};

/** "to the top" / "up to #2" / "down to #5" for a queue move from `from` to `index` (0 = top). */
function moveText(index: number | undefined, from: number | undefined): string {
  if (index === undefined) return 'in the queue';
  if (index === 0) return 'to the top';
  return `${from !== undefined && index > from ? 'down' : 'up'} to #${index + 1}`;
}

export type Severity = 'good' | 'bad' | 'warn' | 'info';

/** Client-derived feed line (no server event): own units whose timed visit ran out arrived back on `plane`. */
export interface ReturnEvent extends ReturnArrival {
  kind: 'transit_return';
}
export type FeedEvent = GameEvent | ReturnEvent;

/** One feed line for `ev` as army `army` of a match with these `armies` (colours name the other armies; `posts` names contested points) reads it. */
export function eventText(ev: FeedEvent, army: ArmyId, armies: Pick<MatchData, 'armies'> & Partial<Pick<MatchData, 'posts'>>): { text: string; sev: Severity } {
  const s = ev.subject ? KIND_LABEL[ev.subject] : 'Unit';
  const ours = ev.side === army;
  switch (ev.kind) {
    case 'transit_return':
      return { text: `${s}${ev.count > 1 ? ` ×${ev.count}` : ''} back in ${PLANE_NAME[ev.plane]}`, sev: 'info' };
    case 'unit_lost':
      return { text: `${s} lost`, sev: 'bad' };
    case 'enemy_killed':
      return { text: `Enemy ${s.toLowerCase()} destroyed`, sev: 'good' };
    case 'structure_lost':
      return { text: `${s} destroyed`, sev: 'bad' };
    case 'structure_destroyed':
      return { text: `Enemy ${s.toLowerCase()} razed`, sev: 'good' };
    case 'produced':
      return { text: `${s} ready`, sev: 'info' };
    case 'constructed':
      return { text: `${s} complete`, sev: 'info' };
    case 'collapse':
      return { text: ours ? 'Our sappers collapsed the ground' : 'Ground collapse!', sev: ours ? 'good' : 'bad' };
    case 'fell_into_depths':
      return { text: `${s} fell into the Depths`, sev: ours ? 'bad' : 'good' };
    case 'impact_incoming':
      if (ev.subject === 'core') return { text: ours ? 'Core deorbited — impact incoming' : 'CORE STRIKE INCOMING', sev: ours ? 'good' : 'warn' };
      return { text: ours ? 'Asteroid deorbited — impact in 8 s' : 'IMPACT INCOMING', sev: ours ? 'good' : 'warn' };
    case 'impact':
      return { text: ev.subject === 'core' ? 'Core strike' : 'Asteroid impact', sev: ours ? 'good' : 'bad' };
    case 'asteroid_intercepted':
      return { text: ev.subject === 'core' ? 'Falling core shot down' : 'Asteroid shot down', sev: ours ? 'good' : 'bad' };
    case 'volatile_detonation':
      return { text: 'Volatile asteroid detonated in Orbit', sev: 'warn' };
    case 'core_lifted':
      return { text: ours ? 'Core towed out of the ruin — it heats up' : 'Enemy towed the derelict core out', sev: ours ? 'info' : 'warn' };
    case 'core_regrows':
      return { text: 'A new derelict core grew in the ruin', sev: 'info' };
    case 'core_cashed':
      return { text: ours ? 'Derelict core cashed in at our segment' : 'Enemy cashed in the derelict core', sev: ours ? 'good' : 'warn' };
    case 'core_meltdown':
      return { text: 'Derelict core melted down', sev: 'warn' };
    case 'core_vented':
      return { text: 'Core vented — heat purged', sev: 'info' };
    case 'irradiated':
      return { text: 'Ships irradiated in the derelict chamber', sev: 'warn' };
    case 'island_captured':
      return { text: ours ? 'Island captured' : 'Enemy captured an island', sev: ours ? 'good' : 'bad' };
    case 'emplaced':
      return { text: `${s} emplaced`, sev: 'good' };
    case 'island_lost':
      return { text: 'Island lost', sev: 'bad' };
    case 'post_captured':
      return { text: `${postName(armies.posts, ev.x, ev.y)} captured`, sev: 'good' };
    case 'post_lost':
      return { text: `${postName(armies.posts, ev.x, ev.y)} lost`, sev: 'bad' };
    case 'spire_damaged':
      // Only delivered to the Spire's owner; `side` is the attacker.
      return { text: `Spire (${PLANE_NAME[ev.plane]}) under attack`, sev: 'warn' };
    case 'enemy_sapper_seen':
      return { text: 'Enemy sapper spotted', sev: 'warn' };
    case 'charge_planted':
      return { text: ours ? 'Charge planted' : 'Allied charge planted', sev: 'good' };
    case 'charge_spotted':
      return { text: 'ENEMY CHARGE found — defuse it or get clear', sev: 'warn' };
    case 'charge_defused':
      return { text: ours ? 'Our charge was defused' : 'Enemy charge defused', sev: ours ? 'bad' : 'good' };
    case 'intruder':
      return { text: `INTRUDERS in our tunnels${ev.count && ev.count > 1 ? ` ×${ev.count}` : ''}`, sev: 'warn' };
    case 'tunnel_breach':
      return { text: ours ? 'We broke into enemy tunnels' : 'Enemy broke into our tunnels', sev: ours ? 'good' : 'warn' };
    case 'breach_tremor':
      return { text: 'TREMORS — troopers digging up', sev: 'warn' };
    case 'breach_opened':
      return { text: ours ? 'Breach open — our troopers are up' : 'ENEMY BREACH — troopers surfacing', sev: ours ? 'good' : 'bad' };
    case 'chasm_opened':
      return { text: ours ? 'Fault split open — chasm' : 'A CHASM tore open along the fault', sev: ours ? 'good' : 'bad' };
    case 'hole_bridged':
      return { text: ours ? 'Hole backfilled' : 'Enemy backfilled a hole', sev: ours ? 'good' : 'warn' };
    case 'magma_flood':
      return { text: ours ? 'Magma pocket breached — tunnels flooding' : 'MAGMA flooding the tunnels', sev: ours ? 'warn' : 'bad' };
    case 'cache_burned':
      return { text: 'Magma burned crater ore', sev: 'warn' };
    case 'lode_erupted':
      return { text: 'The MOTHER LODE ERUPTED — blast and lava in its chamber', sev: 'bad' };
    case 'lode_opened':
      return { text: 'Headframe bored through — the lode pocket is open to diggers', sev: 'good' };
    case 'target_unreachable':
      return { text: `No way into range of the ${ev.subject === 'spire' ? 'enemy Spire' : `enemy ${s.toLowerCase()}`} — attack cancelled`, sev: 'warn' };
    case 'queue_added':
    case 'queue_cancelled':
    case 'queue_moved': {
      const who = ev.by ? seatName(ev.by, ev.byCtl) : 'Someone';
      const own = !ev.owner || (ev.owner === ev.by && ev.ownerCtl === ev.byCtl);
      const whose = own ? 'its' : `${seatName(ev.owner!, ev.ownerCtl)}’s`;
      if (ev.kind === 'queue_added') return { text: `${who} queued ${s}`, sev: 'info' };
      if (ev.kind === 'queue_cancelled' && ev.code === 'out_of_radius') return { text: `${s} cancelled — its build radius was lost`, sev: 'warn' };
      if (ev.kind === 'queue_cancelled') return { text: `${who} cancelled ${whose} ${s}`, sev: 'info' };
      return { text: `${who} moved ${whose} ${s} ${moveText(ev.index, ev.from)}`, sev: 'info' };
    }
    case 'army_eliminated': {
      if (ours) return { text: 'Our Spire fell — eliminated', sev: 'bad' };
      const name = !ev.side || ev.side === 'neutral' ? 'An army' : armyLabel(armies, ev.side);
      const by = ev.killer === undefined ? '' : ev.killer === army ? ' by us' : ` by ${armyLabel(armies, ev.killer)}`;
      return { text: `${name} eliminated${by}`, sev: ev.killer === army ? 'good' : 'info' };
    }
    case 'sudden_death':
      return { text: 'SUDDEN DEATH — every Spire takes extra damage, docks stop repairing', sev: 'warn' };
    case 'crown_lost': {
      const segment = `${PLANE_NAME[ev.plane]} segment`;
      if (ours) return { text: `Our ${segment} fell — a crown lost`, sev: 'bad' };
      const name = !ev.side || ev.side === 'neutral' ? 'An army' : armyLabel(armies, ev.side);
      return { text: `${name} lost its ${segment}${ev.killer === army ? ' to us' : ''}`, sev: ev.killer === army ? 'good' : 'info' };
    }
    case 'segment_rebuilt': {
      const segment = `${PLANE_NAME[ev.plane]} segment`;
      if (ours) return { text: `Our ${segment} rebuilt — crown back`, sev: 'good' };
      const name = !ev.side || ev.side === 'neutral' ? 'An army' : armyLabel(armies, ev.side);
      return { text: `${name} rebuilt its ${segment}`, sev: 'warn' };
    }
  }
}

/** Events that light an alert pip on the plane switcher (for the viewing army). */
export function alertPlanes(ev: GameEvent, army: ArmyId): Plane[] {
  const ours = ev.side === army;
  switch (ev.kind) {
    case 'impact_incoming':
      return ours ? [] : ['surface', 'sky'];
    case 'collapse':
      return ours ? [] : ['surface', 'depths'];
    case 'spire_damaged':
    case 'volatile_detonation':
    case 'core_meltdown':
    case 'irradiated':
      return [ev.plane];
    case 'core_lifted':
      return ours ? [] : ['orbit'];
    case 'enemy_sapper_seen':
      return ['depths'];
    case 'charge_spotted':
      return ['surface', 'depths'];
    case 'intruder':
      return ['depths'];
    case 'tunnel_breach':
      return ours ? [] : ['depths'];
    case 'breach_tremor':
      return ['surface'];
    case 'breach_opened':
    case 'chasm_opened':
      return ours ? [] : ['surface', 'depths'];
    case 'magma_flood':
    case 'lode_erupted':
      return ['depths'];
    case 'sudden_death':
      return [...PLANES];
    case 'island_lost':
      return ['sky'];
    case 'post_lost':
      return ['surface'];
    case 'structure_lost':
    case 'unit_lost':
    case 'fell_into_depths':
      return ours ? [ev.plane] : [];
    default:
      return [];
  }
}

export const PLANE_NAME: Record<Plane, string> = { depths: 'Depths', surface: 'Surface', sky: 'Sky', orbit: 'Orbit' };
/** Plane names as a list: "Surface", "Sky and Orbit", "Depths, Sky and Orbit". */
export function planeList(planes: readonly Plane[]): string {
  const names = planes.map((plane) => PLANE_NAME[plane]);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
export const WEAPON_LABEL: Record<Weapon, string> = { rifle: 'Rifle', cannon: 'Cannon', flak: 'Flak', missile: 'Missile', bomb: 'Bomb', beam: 'Beam', point_defence: 'Point defence', turret: 'Turret gun', pick: 'Pick', shotgun: 'Shotgun', flamer: 'Flamer' };
export const ARMOR_LABEL: Record<Armor, string> = { small: 'Small', light: 'Light', armored: 'Armored', air: 'Air', heavy_air: 'Heavy air', structure: 'Structure', island: 'Island structure' };
export const MOUNT_LABEL: Record<WeaponMount['kind'], string> = {
  turret: 'Turret: aims independently of travel',
  forward: 'Forward: fires inside a cone ahead',
  fixed: 'Fixed: turns the whole body to aim',
};

/** Seconds for display: rule products (digOre × multiplier) without float noise. */
const secs = (n: number): number => Math.round(n * 100) / 100;

/** A research card's tooltip: its docs, what this match's rules make of it, and its research time. */
export function upgradeTip(id: UpgradeId, rules: Rules): string {
  const d = rules.depths;
  const detail = id === 'drill_bits'
    ? `Dig time ×${d.drillBitsDigMultiplier}: rock ${secs(d.digRockTime)}s → ${secs(d.digRockTime * d.drillBitsDigMultiplier)}s, ore ${secs(d.digOreTime)}s → ${secs(d.digOreTime * d.drillBitsDigMultiplier)}s, fortified rock likewise\n`
    : id === 'shaped_charges'
      ? `Fuse ${d.undermineTime}s → ${d.shapedChargesUndermineTime}s · a fault splits ${d.chasmReach} → ${d.shapedChargesChasmReach} cells each way\n`
      : '';
  return `${UPGRADES[id].docs}\n${detail}Research time: ${resolveUpgrade(rules, id).build / TICK_RATE}s`;
}

export const HOLE_PLURAL: Record<HoleKind, string> = { sinkhole: 'sinkholes', crater: 'craters', chasm: 'chasms', breach: 'breaches' };

export const MOTHER_LODE_LABEL = 'Mother Lode';
/** The Mother Lode in one line (empty when the match rules place none: off, or fewer cells than one orbit of the slots). */
export function motherLodeTip(rules: Rules): string {
  const m = rules.map.motherLode, d = rules.depths;
  if (!m.enabled || Math.floor(m.cells / rules.map.slots) === 0) return '';
  const crew = d.motherLodeCrewPerCell === 1 ? 'one digger mines' : `${d.motherLodeCrewPerCell} diggers mine`;
  const reserve = d.motherLodeLoads ? `${d.motherLodeLoads} loads a cell${d.motherLodeRegen ? `, +${d.motherLodeRegen}/s` : ''}` : 'never runs out';
  return `${MOTHER_LODE_LABEL} (${m.placement === 'centre' ? 'map centre' : 'ring around the centre'}): ${crew} each cell at a time, others wait beside it · ${d.motherLodeAlloyPerLoad} alloy a load every ${secs(d.digOreTime * d.motherLodeDig)}s · ${reserve}`;
}

export const RICH_ORE_LABEL = 'Green ore';
/**
 * Pointer tip of a known Depths cell a map feature adds (rules.map.lavaLakes: lake and bridge cells; rules.map.richOre:
 * green ore), with this match's numbers; undefined for every other cell.
 */
export function depthsCellTip(code: number, rules: Rules): { title: string; description: string } | undefined {
  const d = rules.depths;
  switch (code) {
    case CELL.lake:
      return { title: 'Lava lake', description: `Burns ${d.magmaDps}/s, never cools · diggers bridge it: ${d.lavaBridgeCost} alloy, ${secs(d.lavaBridgeTime)}s a cell, up to ${d.lavaBridgeSpan} cells out from dry ground` };
    case CELL.bridge:
      return { title: KIND_LABEL.lava_bridge, description: `Every army crosses · combat, or a charge within ${d.chargeBridgeReach} tiles, drops it into the lava` };
    case CELL.rich:
      return { title: RICH_ORE_LABEL, description: `Mine for ${d.richLoad} alloy a load (ore: ${rules.economy.oreLoad}) · ${secs(d.digRichTime)}s a load` };
  }
  return undefined;
}

/** What the team knows of the Depths, for labels that read a cell: known cell codes, holes and the map size. */
export interface DepthsKnowledge { depths: readonly number[]; holes: readonly { x: number; y: number }[]; size: number }

/**
 * A unit's state for the selection tip; states shared across kinds read per kind (a waiting digger vs a contested
 * island). `bridging` is one sim state for backfilling a hole and decking a lava lake: an own digger's work cell
 * tells them apart; a hostile one (no work point) by the known cells beside it, a hole first.
 */
export function stateLabel(e: Pick<Entity, 'kind' | 'state' | 'x' | 'y' | 'work'>, known?: DepthsKnowledge): string {
  if (e.kind === 'digger' && e.state === 'contested') return `waiting at the ${MOTHER_LODE_LABEL}`;
  if (e.state === 'bridging') return known && bridgingLava(e, known) ? 'bridging lava' : 'backfilling';
  return e.state;
}

function bridgingLava(e: Pick<Entity, 'x' | 'y' | 'work'>, k: DepthsKnowledge): boolean {
  if (e.work) return k.depths[Math.floor(e.work.y) * k.size + Math.floor(e.work.x)] === CELL.lake;
  const x = Math.floor(e.x), y = Math.floor(e.y);
  if (k.holes.some((h) => Math.abs(h.x - x) + Math.abs(h.y - y) === 1)) return false;
  return (x + 1 < k.size && k.depths[y * k.size + x + 1] === CELL.lake) || (x > 0 && k.depths[y * k.size + x - 1] === CELL.lake)
    || k.depths[(y + 1) * k.size + x] === CELL.lake || k.depths[(y - 1) * k.size + x] === CELL.lake;
}

export const ERROR_TEXT: Record<string, string> = {
  unknown_unit: 'Unit no longer exists',
  not_your_unit: 'Not your unit',
  wrong_plane: 'Wrong plane for that order',
  wrong_kind: 'Those units cannot do that',
  cannot_afford: 'Not enough resources',
  invalid_target: 'Invalid target',
  not_adjacent: 'Must be adjacent',
  blocked: 'Blocked',
  no_path: 'No path',
  segment_destroyed: 'Spire segment destroyed',
  queue_full: 'Queue full',
  not_held: 'Island not held',
  occupied: 'Occupied',
  not_visible: 'Target not visible',
  game_over: 'Game over',
  eliminated: 'Your army was eliminated',
  no_lode: 'Headframes go on a lode outcrop',
  out_of_radius: 'Outside your build radius',
  no_build_zone: 'Too close to the enemy Spire',
  no_shaft: 'Troopers change planes only at your own built Shaft',
  shaft_sealed: 'Shaft sealed: dig a tunnel to its landing first',
  forbidden_role: 'Not allowed on this plane',
  rate_limited: 'Too many orders — slow down',
  not_controller: 'Seat not under your control',
  forbidden: 'Not allowed',
  timeout: 'Server did not answer',
  disconnected: 'Disconnected',
};

export const CONTROLLER_BADGE: Record<string, { label: string; cls: string }> = {
  human: { label: 'YOU', cls: 'human' },
  agent: { label: 'AGENT', cls: 'agent' },
  policy: { label: 'POOL', cls: 'policy' },
  bot: { label: 'BOT', cls: 'bot' },
  none: { label: 'OFF', cls: 'none' },
};

export const MACRO_LABEL: Record<Macro, string> = {
  auto_mine: 'Auto-mine',
  guard_root: 'Guard root',
  defend_spire: 'Defend Spire',
  attack_nearest: 'Attack nearest',
  recapture: 'Recapture islands',
  intercept: 'Intercept asteroids',
  harvest_core: 'Fetch the core',
  haul_core: 'Core home',
  spread_arrays: 'Spread arrays',
};

export const PLANE_MACROS: Record<Plane, Macro[]> = {
  depths: ['auto_mine', 'guard_root'],
  surface: ['defend_spire', 'attack_nearest'],
  sky: ['recapture', 'intercept', 'attack_nearest'],
  orbit: ['harvest_core', 'haul_core', 'auto_mine', 'spread_arrays'],
};

export const PLANE_BLURB: Record<Plane, string> = {
  depths: 'Dig tunnels, mine ore, undermine the enemy.',
  surface: 'Classic war. Destroy the enemy Spire.',
  sky: 'Read the weather, capture drifting islands and choose their single build slot.',
  orbit: 'Chase the sun, drop asteroids.',
};
