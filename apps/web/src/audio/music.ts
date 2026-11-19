/**
 * The music deck: which music the player wants (eager, tiny, no WebAudio), stored in this browser. The audio engine
 * reads it (engine.ts) and the music player widget drives it (music-player.ts).
 *
 * - Auto (default): at home the two home themes in turn (Home II first, then Home I, crossfading at the end of each
 *   pass), in the lobby and Create Game the two lobby tracks in turn; in matches the focused plane's bed with the
 *   plane-shift crossfade. Each plane has seven beds and remembers its choice (next/prev step through them; after each
 *   full pass the next one follows). The battle layer takes over near fights, rotating the battle tracks.
 * - Manual: pin one track, or play a group (Home, Lobby, a plane's beds, Battle) as a playlist. Plane switches don't change
 *   the music and the battle layer is off.
 * - Paused silences music only.
 */
import { BATTLE_IDS, STINGS, type BattleId, type MusicId } from './catalog.ts';
import type { Plane } from '@agent-command/game/contract';

export const GROUPS = ['home', 'lobby', 'orbit', 'sky', 'surface', 'depths', 'battle'] as const;
export type GroupId = (typeof GROUPS)[number];
/** Where music plays: the home screen, the lobby (public games, Create Game), a match, or nowhere. */
export type MusicWhere = 'home' | 'lobby' | 'match' | 'none';

/** Each group's tracks in order. */
export const GROUP_TRACKS = {
  home: ['home1', 'home2'],
  lobby: ['lobby1', 'lobby2'],
  orbit: ['bed_orbit_1', 'bed_orbit_2', 'bed_orbit_3', 'bed_orbit_4', 'bed_orbit_5', 'bed_orbit_6', 'bed_orbit_7'],
  sky: ['bed_sky_1', 'bed_sky_2', 'bed_sky_3', 'bed_sky_4', 'bed_sky_5', 'bed_sky_6', 'bed_sky_7'],
  surface: ['bed_surface_1', 'bed_surface_2', 'bed_surface_3', 'bed_surface_4', 'bed_surface_5', 'bed_surface_6', 'bed_surface_7'],
  depths: ['bed_depths_1', 'bed_depths_2', 'bed_depths_3', 'bed_depths_4', 'bed_depths_5', 'bed_depths_6', 'bed_depths_7'],
  battle: BATTLE_IDS,
} as const satisfies Record<GroupId, readonly MusicId[]>;
export type TrackId = (typeof GROUP_TRACKS)[GroupId][number];
/** Every loopable track, grouped order (the Manual list). */
export const TRACKS: readonly TrackId[] = GROUPS.flatMap((g): readonly TrackId[] => GROUP_TRACKS[g]);

/** Group and 1-based position of a track. */
export function trackPlace(id: TrackId): { group: GroupId; n: number; of: number } {
  for (const group of GROUPS) {
    const list: readonly TrackId[] = GROUP_TRACKS[group];
    const i = list.indexOf(id);
    if (i >= 0) return { group, n: i + 1, of: list.length };
  }
  return { group: 'home', n: 1, of: GROUP_TRACKS.home.length };
}

/**
 * Where Auto starts at home and in the lobby (each session; the turn is not stored), and a fresh deck's track: Home II
 * is the default home theme (Home I follows it).
 */
const MENU_FIRST = { home: 'home2', lobby: 'lobby1' } as const satisfies Record<'home' | 'lobby', TrackId>;
const firstTurn = (where: 'home' | 'lobby'): number => (GROUP_TRACKS[where] as readonly TrackId[]).indexOf(MENU_FIRST[where]);

/** Display names (tooltips). */
export const TRACK_NAME: Readonly<Record<TrackId, string>> = {
  home1: 'Home I', home2: 'Home II',
  lobby1: 'War Room I', lobby2: 'War Room II',
  bed_orbit_1: 'Orbit — Vast', bed_orbit_2: 'Orbit — Drift', bed_orbit_3: 'Orbit — Station Dawn',
  bed_orbit_4: 'Orbit — Watch I', bed_orbit_5: 'Orbit — Watch II', bed_orbit_6: 'Orbit — Silence I', bed_orbit_7: 'Orbit — Silence II',
  bed_sky_1: 'Sky — Soaring', bed_sky_2: 'Sky — Glide', bed_sky_3: 'Sky — Before the Storm',
  bed_sky_4: 'Sky — Updraft I', bed_sky_5: 'Sky — Updraft II', bed_sky_6: 'Sky — Gale', bed_sky_7: 'Sky — High Wind',
  bed_surface_1: 'Surface — Front', bed_surface_2: 'Surface — March', bed_surface_3: 'Surface — Column',
  bed_surface_4: 'Surface — Muster I', bed_surface_5: 'Surface — Muster II', bed_surface_6: 'Surface — Iron March', bed_surface_7: 'Surface — Armour',
  bed_depths_1: 'Depths — Machine', bed_depths_2: 'Depths — Drill', bed_depths_3: 'Depths — Magma',
  bed_depths_4: 'Depths — Forge I', bed_depths_5: 'Depths — Forge II', bed_depths_6: 'Depths — Furnace', bed_depths_7: 'Depths — Bore',
  battle_1: 'Battle — Groove', battle_2: 'Battle — Drive', battle_3: 'Battle — Ascent',
  battle_4: 'Battle — Chase I', battle_5: 'Battle — Chase II', battle_6: 'Battle — Grind I', battle_7: 'Battle — Grind II',
};

export type MusicMode = 'auto' | 'manual';

export interface DeckState {
  mode: MusicMode;
  /** Auto: each plane's chosen bed variation (0-based). */
  beds: Record<Plane, number>;
  /** Manual: the pinned or current track, and the group playing as a playlist (none: one track repeats). */
  track: TrackId;
  group: GroupId | null;
  paused: boolean;
}

const STORAGE_KEY = 'agent-command.music';
const variation = (v: unknown, plane: Plane): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < GROUP_TRACKS[plane].length ? v : 0);

/** FNV-style integer hash (deterministic rotation). */
function mixHash(a: number, b: number): number {
  let x = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d) >>> 0;
  return (x ^ (x >>> 12)) >>> 0;
}

/** The match-end sting for `result` of a match with `seed`: one of its takes, deterministic per match. */
export function stingFor(seed: number, result: 'win' | 'loss'): MusicId {
  const takes = STINGS[result];
  return takes[mixHash(seed, 0x5717) % takes.length]!;
}

/**
 * The battle track for battle number `k` (0, 1, 2…) of a match with `seed`: random-looking but deterministic per match,
 * never the same track twice in a row.
 */
export function battleTrack(seed: number, k: number): BattleId {
  let v = mixHash(seed, 0) % BATTLE_IDS.length;
  for (let i = 1; i <= k; i++) v = (v + 1 + (mixHash(seed, i) % (BATTLE_IDS.length - 1))) % BATTLE_IDS.length;
  return BATTLE_IDS[v]!;
}

export class MusicDeck {
  private current: DeckState | undefined;
  private readonly listeners = new Set<(state: Readonly<DeckState>) => void>();
  /** Bumped on every change, so per-frame readers can compare one number. */
  version = 0;
  /** Auto at home / in the lobby: which track of the two plays (MENU_FIRST each session; not stored). */
  private readonly menuTurn: Record<'home' | 'lobby', number> = { home: firstTurn('home'), lobby: firstTurn('lobby') };

  get state(): Readonly<DeckState> {
    if (!this.current) {
      let stored: Partial<DeckState> = {};
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) stored = JSON.parse(raw) as Partial<DeckState>;
      } catch {
        /* storage unavailable or corrupt: defaults */
      }
      const beds = (stored.beds ?? {}) as Partial<Record<Plane, unknown>>;
      this.current = {
        mode: stored.mode === 'manual' ? 'manual' : 'auto',
        beds: { orbit: variation(beds.orbit, 'orbit'), sky: variation(beds.sky, 'sky'), surface: variation(beds.surface, 'surface'), depths: variation(beds.depths, 'depths') },
        track: TRACKS.includes(stored.track as TrackId) ? stored.track as TrackId : MENU_FIRST.home,
        group: GROUPS.includes(stored.group as GroupId) ? stored.group as GroupId : null,
        paused: stored.paused === true,
      };
    }
    return this.current;
  }

  private changed(): void {
    this.version++;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      /* storage unavailable: this session only */
    }
    for (const l of this.listeners) l(this.state);
  }

  /** The bed Auto plays on `plane`. */
  bed(plane: Plane): TrackId {
    return GROUP_TRACKS[plane][this.state.beds[plane]]!;
  }

  setMode(mode: MusicMode): void {
    const s = this.state as DeckState;
    if (s.mode === mode) return;
    s.mode = mode;
    this.changed();
  }

  /** Auto: step `plane`'s bed variation (remembered). */
  stepBed(plane: Plane, delta: 1 | -1): void {
    const s = this.state as DeckState;
    const n = GROUP_TRACKS[plane].length;
    s.beds[plane] = (s.beds[plane] + delta + n) % n;
    this.changed();
  }

  /** Auto at home or in the lobby: that group's next track (next/prev, and after each full pass). */
  stepMenu(where: 'home' | 'lobby', delta: 1 | -1): void {
    const n = GROUP_TRACKS[where].length;
    this.menuTurn[where] = (this.menuTurn[where] + delta + n) % n;
    this.version++;
    for (const l of this.listeners) l(this.state);
  }

  /** Manual: pin one track. */
  pin(track: TrackId): void {
    const s = this.state as DeckState;
    if (s.mode === 'manual' && s.track === track && s.group === null) return;
    s.mode = 'manual';
    s.track = track;
    s.group = null;
    this.changed();
  }

  /**
   * Manual: play a group as a playlist, from its first track (the home group: Home II, the default) or the current
   * one when it belongs to the group.
   */
  playGroup(group: GroupId): void {
    const s = this.state as DeckState;
    const list: readonly TrackId[] = GROUP_TRACKS[group];
    s.mode = 'manual';
    s.group = group;
    if (!list.includes(s.track)) s.track = group === 'home' || group === 'lobby' ? MENU_FIRST[group] : list[0]!;
    this.changed();
  }

  /** Manual: next/previous track, within the playing group, else through the whole list. */
  step(delta: 1 | -1): void {
    const s = this.state as DeckState;
    const list: readonly TrackId[] = s.group ? GROUP_TRACKS[s.group] : TRACKS;
    const i = Math.max(0, list.indexOf(s.track));
    s.track = list[(i + delta + list.length) % list.length]!;
    this.changed();
  }

  /**
   * The track the deck plays at `where` with `focus` (before the battle layer): Manual's track anywhere; Auto's current
   * home theme at home or the focused plane's bed in a match; nothing elsewhere (silent scene, match outcome).
   */
  cue(where: MusicWhere, focus: Plane): TrackId | undefined {
    if (where === 'none') return undefined;
    const s = this.state;
    if (s.mode === 'manual') return s.track;
    return where === 'match' ? this.bed(focus) : GROUP_TRACKS[where][this.menuTurn[where]]!;
  }

  /** The track `next(1, …)` would move to (for preloading), or undefined when it stays. */
  peekNext(where: MusicWhere, focus: Plane): TrackId | undefined {
    const s = this.state;
    if (s.mode === 'manual') {
      const list: readonly TrackId[] = s.group ? GROUP_TRACKS[s.group] : TRACKS;
      return list[(Math.max(0, list.indexOf(s.track)) + 1) % list.length];
    }
    if (where === 'match') return GROUP_TRACKS[focus][(s.beds[focus] + 1) % GROUP_TRACKS[focus].length];
    if (where === 'home' || where === 'lobby') return GROUP_TRACKS[where][(this.menuTurn[where] + 1) % GROUP_TRACKS[where].length];
    return undefined;
  }

  /** The player's next/previous: Manual steps its list; Auto steps the home or lobby tracks there, the plane's beds in a match. */
  next(delta: 1 | -1, where: MusicWhere, focus: Plane): void {
    if (this.state.mode === 'manual') this.step(delta);
    else if (where === 'match') this.stepBed(focus, delta);
    else if (where === 'home' || where === 'lobby') this.stepMenu(where, delta);
  }

  play(): void {
    if (!this.state.paused) return;
    (this.state as DeckState).paused = false;
    this.changed();
  }

  pause(): void {
    if (this.state.paused) return;
    (this.state as DeckState).paused = true;
    this.changed();
  }

  /** Changes. Returns unsubscribe. */
  onChange(listener: (state: Readonly<DeckState>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test hook: forget the cached state so the next read comes from storage. */
  reload(): void {
    this.current = undefined;
    this.menuTurn.home = firstTurn('home');
    this.menuTurn.lobby = firstTurn('lobby');
    this.version++;
  }
}

/** The one deck of this page. */
export const musicDeck = new MusicDeck();
