/**
 * Sound catalog: every music track and effect, its file(s), category and level. Files are resolved with
 * import.meta.glob, so an absent file (or the whole assets/audio directory) simply leaves that sound silent: the game
 * ships and runs with or without audio assets. Loop points are in 48 kHz frames of the encoded file (wrap padding of
 * LOOP_PAD frames on each side keeps codec edge effects outside the loop).
 */
import type { Plane } from '@agent-command/game/contract';

export const MUSIC_IDS = [
  'home1', 'home2', 'lobby1', 'lobby2',
  'bed_orbit_1', 'bed_orbit_2', 'bed_orbit_3', 'bed_orbit_4', 'bed_orbit_5', 'bed_orbit_6', 'bed_orbit_7',
  'bed_sky_1', 'bed_sky_2', 'bed_sky_3', 'bed_sky_4', 'bed_sky_5', 'bed_sky_6', 'bed_sky_7',
  'bed_surface_1', 'bed_surface_2', 'bed_surface_3', 'bed_surface_4', 'bed_surface_5', 'bed_surface_6', 'bed_surface_7',
  'bed_depths_1', 'bed_depths_2', 'bed_depths_3', 'bed_depths_4', 'bed_depths_5', 'bed_depths_6', 'bed_depths_7',
  'battle_1', 'battle_2', 'battle_3', 'battle_4', 'battle_5', 'battle_6', 'battle_7',
  'victory', 'defeat', 'sting_victory_1', 'sting_victory_2', 'sting_defeat_1', 'sting_defeat_2',
] as const;
export type MusicId = (typeof MUSIC_IDS)[number];
/** Battle layer tracks (Auto mode rotates them per battle, see music.ts `battleTrack`). */
export const BATTLE_IDS = ['battle_1', 'battle_2', 'battle_3', 'battle_4', 'battle_5', 'battle_6', 'battle_7'] as const satisfies readonly MusicId[];
/** Match-end stinger takes per result; one plays per match end (music.ts `stingFor`). */
export const STINGS = {
  win: ['victory', 'sting_victory_1', 'sting_victory_2'],
  loss: ['defeat', 'sting_defeat_1', 'sting_defeat_2'],
} as const satisfies Record<'win' | 'loss', readonly MusicId[]>;
export type BattleId = (typeof BATTLE_IDS)[number];

export const SFX_IDS = [
  'ui_click', 'ui_confirm', 'ui_error', 'alert',
  'w_rifle', 'w_skiff', 'w_cannon', 'w_turret', 'w_flak', 'w_missile', 'w_bomb', 'w_beam', 'w_pd', 'w_bastion_pd',
  'lance_charge', 'lance_fire',
  'imp_small', 'exp_large', 'collapse', 'asteroid_impact', 'volatile',
  'dig', 'magma', 'thunder', 'breach', 'tremor', 'tug_tow', 'shield_hit', 'shield_break', 'construction', 'research', 'scan',
  'w_shotgun', 'w_platform', 'wall_deploy', 'wall_undeploy', 'flare_launch', 'flare_fizz', 'anchor_on', 'anchor_off',
  'seeder_charge', 'seeder_burst', 'shaft_lift', 'attach_lock', 'attach_release', 'attach_servo', 'gunship_land',
  'siege_lock', 'siege_unlock', 'dig_in', 'flak_emplace', 'post_capture',
  'core_pickup', 'core_heat', 'vent_hiss', 'meltdown', 'lode_pick', 'backfill', 'w_flamer', 'convert_done',
  'mine_extract', 'mine_depleted', 'cargo_unload', 'tug_drop', 'mine_loop',
  'wind_loop', 'storm_loop', 'hum_orbit', 'hum_air', 'hum_depths', 'drill_loop', 'treads_loop', 'tow_loop', 'machinery_loop',
  'rotor_loop', 'flag_loop', 'gate_loop', 'radiation_loop', 'yard_loop',
] as const;
export type SfxId = (typeof SFX_IDS)[number];

export type SoundKey = `music/${MusicId}` | `sfx/${SfxId}`;

/** Voice-limited effect categories: at most `max` concurrent voices each (a 40-ship brawl stays legible). */
export const SFX_CATEGORIES = {
  ui: { max: 3 },
  weapon: { max: 10 },
  explosion: { max: 6 },
  world: { max: 4 },
  shield: { max: 3 },
  cue: { max: 2 },
  // Alerts cannot be displaced by simultaneous construction/research receipts.
  alert: { max: 1 },
} as const;
export type SfxCategory = keyof typeof SFX_CATEGORIES;

export interface SfxDef {
  readonly cat: SfxCategory;
  /** Linear level relative to the SFX bus. */
  readonly gain: number;
  /** Concurrent voices of this one sound. */
  readonly max: number;
  /** Minimum ms between two starts of this sound (stacked identical starts only add phasing). */
  readonly gap: number;
}
const sfx = (cat: SfxCategory, gain: number, max = 3, gap = 40): SfxDef => ({ cat, gain, max, gap });

export const SFX: Readonly<Record<Exclude<SfxId, LoopId>, SfxDef>> = {
  ui_click: sfx('ui', 0.35, 2, 30),
  ui_confirm: sfx('ui', 0.6, 1, 60),
  ui_error: sfx('ui', 0.6, 1, 120),
  alert: sfx('alert', 0.7, 1, 600),
  // Repeated fire sits below completion/alert cues; heavy weapons retain their weight.
  w_rifle: sfx('weapon', 0.3, 3, 75),
  w_skiff: sfx('weapon', 0.28, 3, 75),
  w_cannon: sfx('weapon', 0.46, 3, 90),
  w_turret: sfx('weapon', 0.38, 2, 100),
  w_flak: sfx('weapon', 0.36, 3, 90),
  w_missile: sfx('weapon', 0.4, 3, 110),
  w_bomb: sfx('weapon', 0.46, 2, 140),
  w_beam: sfx('weapon', 0.36, 2, 120),
  w_pd: sfx('weapon', 0.24, 2, 100),
  w_bastion_pd: sfx('weapon', 0.28, 2, 100),
  lance_charge: sfx('weapon', 0.7, 2, 300),
  lance_fire: sfx('weapon', 0.9, 2, 200),
  imp_small: sfx('explosion', 0.32, 3, 90),
  exp_large: sfx('explosion', 0.62, 3, 140),
  collapse: sfx('explosion', 0.72, 2, 300),
  asteroid_impact: sfx('explosion', 0.85, 2, 300),
  volatile: sfx('explosion', 0.8, 2, 300),
  dig: sfx('world', 0.3, 2, 350),
  magma: sfx('world', 0.6, 1, 1500),
  thunder: sfx('world', 0.75, 2, 400),
  breach: sfx('world', 0.7, 2, 300),
  tremor: sfx('world', 0.6, 1, 2500),
  tug_tow: sfx('world', 0.55, 2, 400),
  shield_hit: sfx('shield', 0.35, 2, 90),
  shield_break: sfx('shield', 0.6, 2, 150),
  construction: sfx('cue', 0.75, 1, 400),
  research: sfx('cue', 0.6, 1, 400),
  scan: sfx('world', 0.5, 1, 400),
  // Warden: shotgun, shield wall, flare
  w_shotgun: sfx('weapon', 0.4, 3, 90),
  wall_deploy: sfx('world', 0.5, 2, 200),
  wall_undeploy: sfx('world', 0.45, 2, 200),
  flare_launch: sfx('world', 0.5, 2, 200),
  flare_fizz: sfx('world', 0.4, 2, 300),
  // Existing electromagnetic lock recordings, now driven by Mooring Tower catch/release.
  anchor_on: sfx('world', 0.6, 1, 1000),
  anchor_off: sfx('world', 0.55, 1, 1000),
  seeder_charge: sfx('world', 0.6, 1, 1000),
  seeder_burst: sfx('explosion', 0.8, 1, 1000),
  // a unit riding a Shaft's cage between the Surface and the Depths
  shaft_lift: sfx('world', 0.45, 2, 400),
  // generic island hardpoint: any attachment clamps in, settles and unlatches
  attach_lock: sfx('world', 0.55, 2, 200),
  attach_release: sfx('world', 0.55, 2, 200),
  attach_servo: sfx('world', 0.35, 2, 300),
  // Gunship emplace (landing, then attach_lock) and its platform turret
  gunship_land: sfx('world', 0.6, 2, 300),
  w_platform: sfx('weapon', 0.38, 2, 100),
  // Surface deploy states and forward posts
  siege_lock: sfx('world', 0.5, 2, 200),
  siege_unlock: sfx('world', 0.5, 2, 200),
  dig_in: sfx('world', 0.45, 2, 300),
  flak_emplace: sfx('world', 0.5, 2, 200),
  post_capture: sfx('world', 0.6, 1, 600),
  // the derelict ruin
  core_pickup: sfx('world', 0.6, 1, 400),
  core_heat: sfx('world', 0.55, 1, 1000),
  vent_hiss: sfx('world', 0.45, 2, 400),
  meltdown: sfx('explosion', 1, 1, 1000),
  // Surface: the Breacher's flame cone, a Drill Yard finishing a conversion
  w_flamer: sfx('weapon', 0.4, 3, 120),
  convert_done: sfx('cue', 0.6, 1, 400),
  // Depths: Mother Lode picks, backfill
  lode_pick: sfx('world', 0.35, 2, 350),
  backfill: sfx('world', 0.45, 2, 400),
  // Orbit utility cues: an extraction start, exhaustion, delivery and deliberate tractor release.
  mine_extract: sfx('world', 0.45, 2, 400),
  mine_depleted: sfx('world', 0.6, 1, 700),
  cargo_unload: sfx('cue', 0.6, 1, 500),
  tug_drop: sfx('world', 0.5, 2, 400),
};

/** Ambience loops at any zoom (weather). */
export type AmbienceId = 'wind_loop' | 'storm_loop';
export const AMBIENCE_IDS: readonly AmbienceId[] = ['wind_loop', 'storm_loop'];

/**
 * Close-zoom activity loops: each category is a small fixed pool of looping voices (ACTIVITY_VOICES), panned toward
 * where visible units near the camera focus are drilling, driving, flying, towing or working machinery (also Gunship
 * rotors, flags at forward posts, the derelict's grinding gate and its radiation, a Drill Yard at work).
 */
export const ACTIVITY_IDS = ['drill', 'mine', 'treads', 'engine_air', 'engine_orbit', 'engine_depths', 'tow', 'machinery', 'rotor', 'flag', 'gate', 'radiation', 'yard'] as const;
export type ActivityId = (typeof ACTIVITY_IDS)[number];
export const ACTIVITY_VOICES = 2;
export const ACTIVITY: Readonly<Record<ActivityId, { loop: SfxId; gain: number }>> = {
  drill: { loop: 'drill_loop', gain: 0.5 },
  mine: { loop: 'mine_loop', gain: 0.4 },
  treads: { loop: 'treads_loop', gain: 0.5 },
  engine_air: { loop: 'hum_air', gain: 0.45 },
  engine_orbit: { loop: 'hum_orbit', gain: 0.45 },
  engine_depths: { loop: 'hum_depths', gain: 0.4 },
  tow: { loop: 'tow_loop', gain: 0.45 },
  machinery: { loop: 'machinery_loop', gain: 0.35 },
  rotor: { loop: 'rotor_loop', gain: 0.4 },
  flag: { loop: 'flag_loop', gain: 0.28 },
  gate: { loop: 'gate_loop', gain: 0.35 },
  radiation: { loop: 'radiation_loop', gain: 0.28 },
  yard: { loop: 'yard_loop', gain: 0.35 },
};
export type LoopId = AmbienceId | 'hum_orbit' | 'hum_air' | 'hum_depths' | 'drill_loop' | 'treads_loop' | 'tow_loop' | 'machinery_loop'
  | 'rotor_loop' | 'flag_loop' | 'gate_loop' | 'radiation_loop' | 'yard_loop' | 'mine_loop';

const WEATHER: readonly Plane[] = ['sky', 'surface'];
const ORBIT: readonly Plane[] = ['orbit'];
const SKY: readonly Plane[] = ['sky'];
const SURFACE: readonly Plane[] = ['surface'];
const DEPTHS: readonly Plane[] = ['depths'];
const UNDERGROUND: readonly Plane[] = ['surface', 'depths'];
const ORBIT_DEPTHS: readonly Plane[] = ['orbit', 'depths'];

/**
 * Plane-bound sounds and the planes in view (Listener.plane) where each is heard; silent from every other plane.
 * Weather is heard under the clouds (the Sky, muffled on the Surface), the derelict ruin in Orbit only, each plane's
 * own work, machinery and engines on that plane only. Unlisted sounds (combat, cues) are heard from every plane, other
 * planes muffled by distance (the engine's far bus).
 */
export const HEARD_ON: Readonly<Partial<Record<SfxId, readonly Plane[]>>> = {
  // weather
  thunder: WEATHER, seeder_charge: WEATHER, seeder_burst: WEATHER, wind_loop: WEATHER, storm_loop: WEATHER,
  // the derelict ruin; its grinding gate loop is also the Mother Lode's pressure rumble in the Depths (the director feeds
  // each only with its own plane in view)
  gate_loop: ORBIT_DEPTHS, radiation_loop: ORBIT, core_pickup: ORBIT, core_heat: ORBIT, vent_hiss: ORBIT, meltdown: ORBIT,
  // Orbit: ship engines, tug grapples and tows, the Lancer's sun lance
  hum_orbit: ORBIT, tow_loop: ORBIT, tug_tow: ORBIT, lance_charge: ORBIT, lance_fire: ORBIT,
  mine_loop: ORBIT, mine_extract: ORBIT, mine_depleted: ORBIT, cargo_unload: ORBIT, tug_drop: ORBIT,
  // Sky: aircraft, islands and their hardpoints
  hum_air: SKY, rotor_loop: SKY, anchor_on: SKY, anchor_off: SKY, attach_lock: SKY, attach_release: SKY, attach_servo: SKY, gunship_land: SKY,
  // Surface: vehicles, headframes, Drill Yards, forward posts, deploy stances
  treads_loop: SURFACE, machinery_loop: SURFACE, yard_loop: SURFACE, convert_done: SURFACE, flag_loop: SURFACE, post_capture: SURFACE,
  siege_lock: SURFACE, siege_unlock: SURFACE, flak_emplace: SURFACE,
  // between the Surface and the Depths: Shaft cages, breaches, troopers digging in on either
  shaft_lift: UNDERGROUND, breach: UNDERGROUND, dig_in: UNDERGROUND,
  // Depths: digging, magma, Mother Lode picks, backfill, tremors, the Warden
  hum_depths: DEPTHS, drill_loop: DEPTHS, dig: DEPTHS, magma: DEPTHS, lode_pick: DEPTHS, backfill: DEPTHS, tremor: DEPTHS,
  w_shotgun: DEPTHS, wall_deploy: DEPTHS, wall_undeploy: DEPTHS, flare_launch: DEPTHS, flare_fizz: DEPTHS,
};

/** Is sound `id` heard with `plane` in view? */
export function heardOn(id: SfxId, plane: Plane): boolean {
  const on = HEARD_ON[id];
  return on === undefined || on.includes(plane);
}

/** Wrap padding (48 kHz frames) before and after every encoded loop. */
export const LOOP_PAD = 2400;
/** Frames of each 30 s segment file of the streamed tracks (`music/<id>_<n>`); a track's loop is all its segments. */
const STREAMED = {
  home1: [1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1250188],
  home2: [1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1440000, 1872123],
  lobby1: [1440000, 1440000, 806687],
  lobby2: [1440000, 1785295],
  battle_4: [1440000, 1440000, 1440000, 1763592],
  battle_5: [1440000, 1440000, 1440000, 1487128],
  battle_6: [1440000, 1440000, 1440000, 1440000, 872816],
  battle_7: [1440000, 1440000, 1440000, 1901608],
  bed_orbit_4: [1440000, 1440000, 1440000, 1440000, 1440000, 2103918],
  bed_orbit_5: [1440000, 1440000, 1440000, 1440000, 1440000, 2005300],
  bed_orbit_6: [1440000, 1440000, 1440000, 1440000, 1778837],
  bed_orbit_7: [1440000, 1440000, 1440000, 1440000, 1440000, 2016318],
  bed_sky_4: [1440000, 1440000, 1984848],
  bed_sky_5: [1440000, 1440000, 1440000, 1440000, 1407776],
  bed_sky_6: [1440000, 1440000, 1440000, 1440000, 874640],
  bed_sky_7: [1440000, 1440000, 1440000, 731184],
  bed_surface_4: [1440000, 1440000, 1440000, 779352],
  bed_surface_5: [1440000, 1440000, 1783684],
  bed_surface_6: [1440000, 1440000, 1745284],
  bed_surface_7: [1440000, 1440000, 1674700],
  bed_depths_4: [1440000, 1440000, 1440000, 1440000, 1440000, 786747],
  bed_depths_5: [1440000, 1440000, 1440000, 1440000, 1799742],
  bed_depths_6: [1440000, 1440000, 1440000, 2151648],
  bed_depths_7: [1440000, 1440000, 1695420],
} as const satisfies Partial<Record<MusicId, readonly number[]>>;
const RATE = 48000;
/** Loop length in 48 kHz frames per single looping file. */
const LOOP_FRAMES: Readonly<Partial<Record<SoundKey, number>>> = {
  'music/bed_orbit_1': 3636815,
  'music/bed_orbit_2': 3664076,
  'music/bed_orbit_3': 3607570,
  'music/bed_sky_1': 3396414,
  'music/bed_sky_2': 3379797,
  'music/bed_sky_3': 3807799,
  'music/bed_surface_1': 3648045,
  'music/bed_surface_2': 3743644,
  'music/bed_surface_3': 3559870,
  'music/bed_depths_1': 3862547,
  'music/bed_depths_2': 3760254,
  'music/bed_depths_3': 3680226,
  'music/battle_1': 4166400,
  'music/battle_2': 4258943,
  'music/battle_3': 3456022,
  'sfx/wind_loop': 288000,
  'sfx/storm_loop': 288000,
  'sfx/hum_orbit': 192000,
  'sfx/hum_air': 192000,
  'sfx/hum_depths': 192000,
  'sfx/drill_loop': 192000,
  'sfx/treads_loop': 192000,
  'sfx/tow_loop': 192000,
  'sfx/machinery_loop': 192000,
  'sfx/rotor_loop': 192000,
  'sfx/flag_loop': 192000,
  'sfx/gate_loop': 192000,
  'sfx/radiation_loop': 192000,
  'sfx/yard_loop': 192000,
  'sfx/mine_loop': 192000,
};

/**
 * Streamed tracks (the home and lobby themes, the newer beds and battle tracks) are consecutive segment files
 * `music/<id>_<n>`, each with LOOP_PAD frames of its neighbours (circularly) on both sides; the engine plays them back
 * to back and heals each boundary.
 */
export const SEGMENTS: Readonly<Partial<Record<SoundKey, readonly number[]>>> = Object.fromEntries(
  Object.entries(STREAMED).map(([id, frames]) => [`music/${id}`, frames]),
);
/** File of segment `i` (0-based) of a segmented track. */
export const segmentFile = (key: SoundKey, i: number): string => `${key}_${i + 1}`;

/** Seconds [start, end) of a looping file's seamless loop (a segmented track: its whole length), or undefined. */
export function loopOf(key: SoundKey): { start: number; end: number } | undefined {
  const n = LOOP_FRAMES[key] ?? SEGMENTS[key]?.reduce((a, b) => a + b, 0);
  return n === undefined ? undefined : { start: LOOP_PAD / RATE, end: (LOOP_PAD + n) / RATE };
}

/** Music levels relative to the music bus. */
export const MUSIC_GAIN: Readonly<Record<MusicId, number>> = {
  home1: 0.9, home2: 0.9, lobby1: 0.8, lobby2: 0.8,
  bed_orbit_1: 0.8, bed_orbit_2: 0.8, bed_orbit_3: 0.8, bed_orbit_4: 0.8, bed_orbit_5: 0.8, bed_orbit_6: 0.8, bed_orbit_7: 0.8,
  bed_sky_1: 0.8, bed_sky_2: 0.8, bed_sky_3: 0.8, bed_sky_4: 0.8, bed_sky_5: 0.8, bed_sky_6: 0.8, bed_sky_7: 0.8,
  bed_surface_1: 0.75, bed_surface_2: 0.75, bed_surface_3: 0.75, bed_surface_4: 0.75, bed_surface_5: 0.75, bed_surface_6: 0.75, bed_surface_7: 0.75,
  bed_depths_1: 0.8, bed_depths_2: 0.8, bed_depths_3: 0.8, bed_depths_4: 0.8, bed_depths_5: 0.8, bed_depths_6: 0.8, bed_depths_7: 0.8,
  battle_1: 0.85, battle_2: 0.85, battle_3: 0.85, battle_4: 0.85, battle_5: 0.85, battle_6: 0.85, battle_7: 0.85,
  victory: 1, defeat: 1, sting_victory_1: 1, sting_victory_2: 1, sting_defeat_1: 1, sting_defeat_2: 1,
};

/** Important moments get a non-verbal alert chirp, each with its own cooldown (ms). */
export const ALERT_CUES = { base_under_attack: 25000, spire_segment_lost: 5000, breakthrough: 15000, asteroid_incoming: 12000 } as const;
export type AlertCue = keyof typeof ALERT_CUES;

/**
 * Files present at build time, as hashed URLs (never inlined: the CSP's connect-src does not allow data: fetches).
 * Missing files are simply absent here (that sound stays silent).
 */
const FILES = import.meta.glob<string>('../../assets/audio/*/*.ogg', { query: '?no-inline', import: 'default', eager: true });

/** URL of a sound file (`music/bed_sky`, or a segment like `music/home1_1`), or undefined when it is not shipped. */
export function soundUrl(file: string): string | undefined {
  return FILES[`../../assets/audio/${file}.ogg`];
}

/**
 * Files fetched right after the home screen is interactive (≤ 1.5 MB): the first segment of Home II (the default home
 * theme) and the UI clicks.
 */
export const INITIAL_FILES: readonly string[] = ['music/home2_1', 'sfx/ui_click', 'sfx/ui_confirm', 'sfx/ui_error'];
